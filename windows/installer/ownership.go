//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

const (
	receiptName = ".grokbot-installation.json"
	markerName  = "resources/grokbot-local.patch.json"
	appID       = "dev.grokbot.local"
)

type ownedFile struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

type dirID struct {
	Volume uint32 `json:"volume"`
	Index  uint64 `json:"index"`
	Birth  uint64 `json:"birth"`
}

type ownedDir struct {
	Path string `json:"path"`
	ID   dirID  `json:"id"`
}

type receipt struct {
	Format      int         `json:"format"`
	AppID       string      `json:"appId"`
	Directory   string      `json:"directory"`
	RootID      dirID       `json:"rootId"`
	CreatedRoot bool        `json:"createdRoot"`
	LegacyFrom  string      `json:"sideBySideOf,omitempty"`
	Files       []ownedFile `json:"files"`
	Dirs        []ownedDir  `json:"dirs"`
	digest      string
}

func localName(name string) bool {
	if name == "." || !fs.ValidPath(name) || strings.ContainsAny(name, `\:<>"|?*`) || !filepath.IsLocal(filepath.FromSlash(name)) {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") || strings.IndexFunc(part, func(r rune) bool { return r < 32 }) >= 0 {
			return false
		}
	}
	return true
}

func checkLocation(dir string) error {
	volume := filepath.VolumeName(dir)
	// Only ordinary absolute drive paths. Device namespaces, roots and dot aliases
	// must never be interpreted as an install location or its parents.
	if !filepath.IsAbs(dir) || len(volume) != 2 || volume[1] != ':' ||
		!localName(strings.TrimPrefix(filepath.ToSlash(dir[len(volume):]), "/")) {
		return fmt.Errorf("invalid installation directory: %s", dir)
	}
	return nil
}

func reparse(info fs.FileInfo) bool {
	attrs, ok := info.Sys().(*syscall.Win32FileAttributeData)
	return !ok || attrs.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0
}

// Check every existing component, including parents of a not-yet-created target.
func plainPath(name string) (fs.FileInfo, error) {
	parent := filepath.Dir(name)
	if parent != name {
		info, err := plainPath(parent)
		if err != nil {
			return nil, err
		}
		if !info.IsDir() {
			return nil, fmt.Errorf("not a directory: %s", parent)
		}
	}
	info, err := os.Lstat(name)
	if err == nil && reparse(info) {
		return nil, fmt.Errorf("refusing reparse point: %s", name)
	}
	return info, err
}

func fileDigest(name string) (string, error) {
	info, err := plainPath(name)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("not a regular file: %s", name)
	}
	f, err := os.Open(name)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func checkMarker(dir string) error {
	name := filepath.Join(dir, markerName)
	info, err := plainPath(name)
	if err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("missing patch marker: %s", dir)
	}
	var marker struct {
		AppUserModelID string `json:"appUserModelId"`
	}
	data, err := os.ReadFile(name)
	if err != nil || json.Unmarshal(data, &marker) != nil || marker.AppUserModelID != appID {
		return fmt.Errorf("unrecognized patch marker: %s", dir)
	}
	return nil
}

func (r *receipt) validate(dir string) error {
	if r.Format != 1 || r.AppID != appID || !strings.EqualFold(r.Directory, dir) {
		return fmt.Errorf("installation receipt does not belong to %s", dir)
	}
	if r.LegacyFrom != "" && (checkLocation(r.LegacyFrom) != nil || !strings.EqualFold(siblingDirectory(r.LegacyFrom), dir)) {
		return fmt.Errorf("invalid side-by-side installation receipt: %s", dir)
	}
	seen := map[string]bool{receiptName: true}
	check := func(name string, isFile bool) error {
		key := strings.ToLower(name)
		if _, exists := seen[key]; exists || !localName(name) {
			return fmt.Errorf("invalid or duplicate receipt path: %q", name)
		}
		seen[key] = isFile
		return nil
	}
	for _, dir := range r.Dirs {
		if err := check(dir.Path, false); err != nil {
			return err
		}
	}
	for _, file := range r.Files {
		if err := check(file.Path, true); err != nil {
			return err
		}
		if digest, err := hex.DecodeString(file.SHA256); err != nil || len(digest) != sha256.Size {
			return fmt.Errorf("invalid file digest: %s", file.Path)
		}
	}
	for _, required := range []string{exeName, uninstaller, markerName} {
		if !seen[strings.ToLower(required)] {
			return fmt.Errorf("missing installed file: %s", required)
		}
	}
	return nil
}

// No receipt is needed for a new or empty destination. An older installer only
// wrote a portable patch marker; that marker cannot establish ownership of files.
func inspectDirectory(dir string, installing bool) (*receipt, bool, error) {
	if err := checkLocation(dir); err != nil {
		return nil, false, err
	}
	info, err := plainPath(dir)
	if installing && errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if !info.IsDir() {
		return nil, false, fmt.Errorf("not an installation directory: %s", dir)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, false, err
	}
	if installing && len(entries) == 0 {
		return nil, true, nil
	}
	name := filepath.Join(dir, receiptName)
	info, err = plainPath(name)
	if errors.Is(err, os.ErrNotExist) && legacyDirectory(dir) {
		return nil, true, legacyInstallation(dir)
	}
	if err != nil || !info.Mode().IsRegular() {
		return nil, true, fmt.Errorf("no installation receipt for %s; leave this folder intact and install to a new directory", dir)
	}
	data, err := os.ReadFile(name)
	if err != nil {
		return nil, true, err
	}
	var r receipt
	if err := json.Unmarshal(data, &r); err != nil {
		return nil, true, err
	}
	if err := r.validate(dir); err != nil {
		return nil, true, err
	}
	if err := checkMarker(dir); err != nil {
		return nil, true, err
	}
	r.digest = fmt.Sprintf("%x", sha256.Sum256(data))
	return &r, true, nil
}

// Inventory only the freshly extracted private staging tree, never an existing
// installation: user additions must not turn into installer-owned files on upgrade.
func inventory(stage, dir string, createdRoot bool) (*receipt, error) {
	if err := checkMarker(stage); err != nil {
		return nil, err
	}
	r := &receipt{Format: 1, AppID: appID, Directory: dir, CreatedRoot: createdRoot}
	err := filepath.WalkDir(stage, func(name string, entry fs.DirEntry, err error) error {
		if err != nil || name == stage {
			return err
		}
		rel, err := filepath.Rel(stage, name)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if entry.IsDir() {
			r.Dirs = append(r.Dirs, ownedDir{Path: rel})
			return nil
		}
		digest, err := fileDigest(name)
		if err == nil {
			r.Files = append(r.Files, ownedFile{Path: rel, SHA256: digest})
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	return r, r.validate(dir)
}
