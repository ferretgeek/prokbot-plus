//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"unsafe"
)

func winPath(name string) *uint16 {
	// Callers supply validated absolute drive paths (or private children of them).
	p, _ := syscall.UTF16PtrFromString(`\\?\` + filepath.Clean(name))
	return p
}

// Do not allow a checked ancestor to be renamed or replaced with a junction
// during a transaction. OPEN_REPARSE_POINT inspects the directory itself.
type dirPins map[string]syscall.Handle

func (p dirPins) pin(dir string) error { return p.open(dir, false) }

const deleteAccess = 0x10000

func (p dirPins) open(dir string, removable bool) error {
	key := strings.ToLower(dir)
	if _, ok := p[key]; ok {
		return nil
	}
	if parent := filepath.Dir(dir); parent != dir {
		if err := p.pin(parent); err != nil {
			return err
		}
	}
	var access uint32
	if removable {
		access = deleteAccess
	}
	h, err := syscall.CreateFile(winPath(dir), access, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil,
		syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return &os.PathError{Op: "open directory", Path: dir, Err: err}
	}
	var info syscall.ByHandleFileInformation
	err = syscall.GetFileInformationByHandle(h, &info)
	if err != nil || info.FileAttributes&(syscall.FILE_ATTRIBUTE_REPARSE_POINT|syscall.FILE_ATTRIBUTE_DIRECTORY) != syscall.FILE_ATTRIBUTE_DIRECTORY {
		syscall.CloseHandle(h)
		return fmt.Errorf("not a plain directory: %s", dir)
	}
	p[key] = h
	return nil
}

func (p dirPins) release(dir string) {
	key := strings.ToLower(dir)
	if h, ok := p[key]; ok {
		syscall.CloseHandle(h)
		delete(p, key)
	}
}

func (p dirPins) close() {
	for dir := range p {
		p.release(dir)
	}
}

func (p dirPins) identity(dir string) (dirID, error) {
	if err := p.pin(dir); err != nil {
		return dirID{}, err
	}
	var info syscall.ByHandleFileInformation
	err := syscall.GetFileInformationByHandle(p[strings.ToLower(dir)], &info)
	return dirID{info.VolumeSerialNumber, uint64(info.FileIndexHigh)<<32 | uint64(info.FileIndexLow),
		uint64(info.CreationTime.HighDateTime)<<32 | uint64(info.CreationTime.LowDateTime)}, err
}

func (p dirPins) ensure(dir string, created *[]string) error {
	if err := p.pin(dir); !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := p.ensure(filepath.Dir(dir), created); err != nil {
		return err
	}
	if err := os.Mkdir(dir, 0755); err != nil {
		return err
	}
	*created = append(*created, dir)
	return p.pin(dir)
}

var setFileInfo = kernel32.NewProc("SetFileInformationByHandle")

// Delete only the exact directory we pinned, and only if empty. Do not release
// the checked handle and then remove a potentially different object by name.
func (p dirPins) removeEmpty(dir string) (bool, error) {
	before, err := p.identity(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	// Normal directory reads don't share DELETE access. Reopen for removal only
	// at the end; verify the ID across the gap, with the parent still pinned.
	p.release(dir)
	if err := p.open(dir, true); err != nil {
		return false, err
	}
	defer p.release(dir)
	current, err := p.identity(dir)
	if err != nil || before != current {
		return false, fmt.Errorf("directory changed before removal: %s", dir)
	}
	const fileDispositionInfo = 4
	deleteFile := byte(1)
	ok, _, err := setFileInfo.Call(uintptr(p[strings.ToLower(dir)]), fileDispositionInfo, uintptr(unsafe.Pointer(&deleteFile)), 1)
	if ok == 0 && errors.Is(err, syscall.ERROR_DIR_NOT_EMPTY) {
		return false, nil
	}
	if ok == 0 {
		return false, &os.PathError{Op: "remove empty directory", Path: dir, Err: err}
	}
	return true, nil
}

type transaction struct {
	pins   dirPins
	work   string
	undo   []func() error
	retire []string
}

func (tx *transaction) move(from, to string) error {
	for _, name := range []string{from, to} {
		if err := tx.pins.pin(filepath.Dir(name)); err != nil {
			return err
		}
	}
	// Unlike os.Rename on Windows, MoveFileW never replaces an existing target.
	if err := syscall.MoveFile(winPath(from), winPath(to)); err != nil {
		return &os.LinkError{Op: "move", Old: from, New: to, Err: err}
	}
	return nil
}

func verifyFile(name, want string) error {
	have, err := fileDigest(name)
	if err != nil {
		return err
	}
	if have != want {
		return fmt.Errorf("file has changed; refusing to replace or delete it: %s", name)
	}
	return nil
}

func (tx *transaction) mkdir(dir string) error {
	if err := os.Mkdir(dir, 0755); err != nil {
		return err
	}
	tx.undo = append(tx.undo, func() error { _, err := tx.pins.removeEmpty(dir); return err })
	return tx.pins.pin(dir)
}

func (tx *transaction) apply(dir string, prepare func(string) error, integrate func(upgrade bool, sideBySide bool) error, options installOptions) error {
	old, existed, err := inspectDirectory(dir, prepare != nil)
	if err != nil {
		return err
	}
	if err := options.checkTarget(dir, old); err != nil {
		return err
	}
	legacy := options.legacy
	if old != nil {
		legacy = old.LegacyFrom
	}
	stage := filepath.Join(tx.work, "new")
	ownedDirs := make(map[string]string)
	if old != nil {
		for _, owned := range append(old.Dirs, ownedDir{Path: "", ID: old.RootID}) {
			name := filepath.Join(dir, owned.Path)
			id, err := tx.pins.identity(name)
			if err != nil {
				return err
			}
			if id != owned.ID {
				return fmt.Errorf("directory is not the one recorded at installation: %s", name)
			}
			if owned.Path != "" {
				ownedDirs[strings.ToLower(owned.Path)] = owned.Path
			}
		}
	}
	var publish []ownedFile
	if prepare != nil {
		if err := os.Mkdir(stage, 0700); err != nil {
			return err
		}
		if err := prepare(stage); err != nil {
			return err
		}
		next, err := inventory(stage, dir, !existed || (old != nil && old.CreatedRoot))
		if err != nil {
			return err
		}
		next.LegacyFrom = legacy
		if !existed {
			if err := tx.mkdir(dir); err != nil {
				return err
			}
		}
		next.RootID, err = tx.pins.identity(dir)
		if err != nil {
			return err
		}
		wanted := next.Dirs
		next.Dirs = nil
		for _, entry := range wanted {
			name := entry.Path
			dest, key := filepath.Join(dir, name), strings.ToLower(name)
			_, owned := ownedDirs[key]
			if err := tx.pins.pin(dest); errors.Is(err, os.ErrNotExist) {
				if err := tx.mkdir(dest); err != nil {
					return err
				}
				owned = true
			} else if err != nil {
				return err
			}
			if owned {
				entry.ID, err = tx.pins.identity(dest)
				if err != nil {
					return err
				}
				next.Dirs = append(next.Dirs, entry)
			}
			delete(ownedDirs, key)
		}
		data, err := json.MarshalIndent(next, "", "  ")
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(stage, receiptName), data, 0600); err != nil {
			return err
		}
		publish = append(next.Files, ownedFile{receiptName, fmt.Sprintf("%x", sha256.Sum256(data))})
	}
	if old != nil {
		for _, file := range append(old.Files, ownedFile{receiptName, old.digest}) {
			from := filepath.Join(dir, file.Path)
			backup := filepath.Join(tx.work, "previous", file.Path)
			if err := os.MkdirAll(filepath.Dir(backup), 0700); err != nil {
				return err
			}
			info, err := plainPath(from)
			if err != nil {
				return err
			}
			if !info.Mode().IsRegular() {
				return fmt.Errorf("not an installed file: %s", from)
			}
			if err := tx.move(from, backup); err != nil {
				return err
			}
			tx.undo = append(tx.undo, func() error { return tx.move(backup, from) })
			// Verify the object actually moved, not an earlier path lookup.
			if err := verifyFile(backup, file.SHA256); err != nil {
				return fmt.Errorf("%s: %w", from, err)
			}
		}
	}
	for _, file := range publish {
		from, to := filepath.Join(stage, file.Path), filepath.Join(dir, file.Path)
		if err := tx.move(from, to); err != nil {
			return err
		}
		tx.undo = append(tx.undo, func() error {
			if err := tx.move(to, from); err != nil {
				return err
			}
			if err := verifyFile(from, file.SHA256); err != nil {
				return errors.Join(err, tx.move(from, to))
			}
			return nil
		})
	}
	var retired []string
	for _, name := range ownedDirs {
		retired = append(retired, name)
	}
	slices.SortFunc(retired, func(a, b string) int { return len(b) - len(a) })
	for _, name := range retired {
		tx.retire = append(tx.retire, filepath.Join(dir, name))
	}
	if prepare == nil && old.CreatedRoot {
		tx.retire = append(tx.retire, dir)
	}
	return integrate(old != nil, legacy != "")
}

func changeInstallation(dir string, prepare func(string) error, integrate func(bool) error) (result error) {
	return transactInstallation(dir, prepare, func(upgrade, _ bool) error { return integrate(upgrade) }, installOptions{})
}

func transactInstallation(dir string, prepare func(string) error, integrate func(bool, bool) error, options installOptions) (result error) {
	if _, _, err := inspectDirectory(dir, prepare != nil); err != nil {
		return err
	}
	tx := transaction{pins: make(dirPins)}
	var parents []string
	defer func() {
		if result != nil {
			for _, dir := range slices.Backward(parents) {
				_, err := tx.pins.removeEmpty(dir)
				result = errors.Join(result, err)
			}
		}
		tx.pins.close()
	}()
	parent := filepath.Dir(dir)
	if err := tx.pins.ensure(parent, &parents); err != nil {
		return err
	}
	key := sha256.Sum256([]byte(strings.ToLower(filepath.Base(dir))))
	lockPath := filepath.Join(parent, fmt.Sprintf(".grokbot-%x.lock", key[:12]))
	const deleteOnClose = 0x04000000
	lock, err := syscall.CreateFile(winPath(lockPath), syscall.GENERIC_WRITE, 0, nil, syscall.CREATE_NEW, deleteOnClose, 0)
	if err != nil {
		return fmt.Errorf("could not reserve installation directory %s: %w", dir, err)
	}
	defer syscall.CloseHandle(lock)
	if err := tx.pins.pin(dir); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	tx.work, err = os.MkdirTemp(parent, ".grokbot-transaction-*")
	if err != nil {
		return err
	}
	if err := tx.pins.pin(tx.work); err != nil {
		return err
	}
	err = tx.apply(dir, prepare, integrate, options)
	var rollback error
	if err != nil {
		for _, undo := range slices.Backward(tx.undo) {
			rollback = errors.Join(rollback, undo())
		}
	}
	if rollback != nil {
		return errors.Join(err, fmt.Errorf("rollback incomplete; recovery files retained at %s: %w", tx.work, rollback))
	}
	// Keep original directories (and their recorded IDs) intact until all
	// fallible publication/integration steps have committed. A failed cleanup
	// leaves at most an empty directory and is reported, not treated as rollback.
	if err == nil {
		for _, dir := range tx.retire {
			_, cleanupErr := tx.pins.removeEmpty(dir)
			if cleanupErr != nil {
				err = errors.Join(err, fmt.Errorf("file changes committed; directory cleanup: %w", cleanupErr))
			}
		}
	}
	// Keep the workspace and its ancestors pinned while removing the two private
	// subtrees. A directory that appears beside them is never recursively removed.
	for name := range tx.pins {
		if strings.HasPrefix(name, strings.ToLower(tx.work)+`\`) {
			tx.pins.release(name)
		}
	}
	for _, name := range []string{"new", "previous"} {
		err = errors.Join(err, os.RemoveAll(filepath.Join(tx.work, name)))
	}
	removed, cleanupErr := tx.pins.removeEmpty(tx.work)
	if !removed && cleanupErr == nil {
		cleanupErr = fmt.Errorf("transaction workspace is not empty: %s", tx.work)
	}
	return errors.Join(err, cleanupErr)
}
