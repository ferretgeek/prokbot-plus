//go:build windows

package main

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"errors"
	"io/fs"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"syscall"
	"testing"
)

type sandbox struct {
	root, dir, self string
	shell           shellIntegration
	installs        []bool
	uninstalls      int
}

func disposable(t *testing.T) *sandbox {
	t.Helper()
	root := t.TempDir()
	rel, err := filepath.Rel(os.TempDir(), root)
	if err != nil || rel == "." || !filepath.IsLocal(rel) {
		t.Fatalf("not a disposable temp child: %s", root)
	}
	if _, err := plainPath(root); err != nil {
		t.Fatal(err)
	}
	s := &sandbox{root: root, dir: filepath.Join(root, "install"), self: filepath.Join(root, "setup.fixture")}
	wasSilent := silent
	silent = true
	t.Cleanup(func() { silent = wasSilent })
	t.Setenv("APPDATA", filepath.Join(root, "profile"))
	t.Setenv("LOCALAPPDATA", filepath.Join(root, "local"))
	s.shell.install = func(dir, version string, size uint64, fresh bool) error {
		if dir != s.dir || version == "" || size == 0 {
			t.Fatalf("unexpected shell call: %q, %q, %d", dir, version, size)
		}
		s.installs = append(s.installs, fresh)
		return nil
	}
	s.shell.uninstall = func(dir string) error {
		if dir != s.dir {
			t.Fatalf("unexpected shell removal: %q", dir)
		}
		s.uninstalls++
		return nil
	}
	return s
}

func put(t *testing.T, name, data string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(name), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
}

func contents(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func snapshot(t *testing.T, dir string) map[string]string {
	t.Helper()
	files := map[string]string{}
	err := filepath.WalkDir(dir, func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, name)
		if err == nil && name != dir {
			if entry.IsDir() {
				files[filepath.ToSlash(rel)+"/"] = ""
			} else {
				files[filepath.ToSlash(rel)] = contents(t, name)
			}
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func (s *sandbox) payload(t *testing.T, version string, extras map[string]string) {
	t.Helper()
	files := map[string]string{exeName: "synthetic client " + version, markerName: `{"appUserModelId":"dev.grokbot.local"}`}
	maps.Copy(files, extras)
	var body bytes.Buffer
	z := zip.NewWriter(&body)
	if err := z.SetComment(version); err != nil {
		t.Fatal(err)
	}
	for _, name := range slices.Sorted(maps.Keys(files)) {
		w, err := z.CreateHeader(&zip.FileHeader{Name: appName + "/" + name, Method: zip.Store})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = w.Write([]byte(files[name])); err != nil {
			t.Fatal(err)
		}
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	head := []byte("synthetic stub " + version)
	var footer [footerLength]byte
	binary.LittleEndian.PutUint64(footer[:], uint64(len(head)))
	binary.LittleEndian.PutUint64(footer[8:], uint64(body.Len()))
	copy(footer[16:], footerMagic)
	put(t, s.self, string(bytes.Join([][]byte{head, body.Bytes(), footer[:]}, nil)))
}

func (s *sandbox) installed(t *testing.T, extras map[string]string) {
	t.Helper()
	s.payload(t, "1", extras)
	if err := install(s.self, s.dir, "1", s.shell); err != nil {
		t.Fatal(err)
	}
}

func (s *sandbox) remove() error { return uninstall(s.self, s.dir, s.shell, false) }

func (s *sandbox) clean(t *testing.T) {
	t.Helper()
	files, err := os.ReadDir(s.root)
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if strings.HasPrefix(file.Name(), ".grokbot-") {
			t.Fatalf("leaked transaction file: %s", file.Name())
		}
	}
}

func TestNativeLifecyclePreservesPersonalFiles(t *testing.T) {
	s := disposable(t)
	put(t, s.dir+".probe", "existing sibling")
	profile := filepath.Join(os.Getenv("APPDATA"), appName, "preferences")
	put(t, profile, "keep")
	s.installed(t, map[string]string{"old/data": "retired", "common/data": "first"})
	put(t, filepath.Join(s.dir, "old", "personal.txt"), "keep old")
	put(t, filepath.Join(s.dir, "resources", "personal.txt"), "keep nested")
	put(t, filepath.Join(s.dir, "notes"), "keep root")
	if err := os.Mkdir(filepath.Join(s.dir, "my-folder"), 0700); err != nil {
		t.Fatal(err)
	}
	s.payload(t, "2", map[string]string{"my-folder/new": "second", "common/data": "updated"})
	if err := install(s.self, s.dir, "2", s.shell); err != nil {
		t.Fatal(err)
	}
	if got := contents(t, filepath.Join(s.dir, "common", "data")); got != "updated" {
		t.Fatal(got)
	}
	if err := s.remove(); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"my-folder/": "", "old/": "", "old/personal.txt": "keep old", "resources/": "", "resources/personal.txt": "keep nested", "notes": "keep root"}
	if got := snapshot(t, s.dir); !maps.Equal(got, want) {
		t.Fatalf("after uninstall: %#v", got)
	}
	if !reflect.DeepEqual(s.installs, []bool{true, false}) || s.uninstalls != 1 || contents(t, profile) != "keep" || contents(t, s.dir+".probe") != "existing sibling" {
		t.Fatal("unexpected integration or changes outside the installation")
	}
	s.clean(t)
}

func TestNativeUninstallRemovesOnlyAnInstallerCreatedEmptyRoot(t *testing.T) {
	for _, existing := range []bool{false, true} {
		s := disposable(t)
		if existing {
			if err := os.Mkdir(s.dir, 0700); err != nil {
				t.Fatal(err)
			}
		}
		s.installed(t, nil)
		if err := s.remove(); err != nil {
			t.Fatal(err)
		}
		if existing {
			if len(snapshot(t, s.dir)) != 0 {
				t.Fatal("preexisting directory not restored")
			}
		} else if _, err := os.Lstat(s.dir); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("installer-created root remains: %v", err)
		}
		s.clean(t)
	}
}

func TestNativeLegacyAndCopiedReceiptsAreNotOwnership(t *testing.T) {
	s := disposable(t)
	s.installed(t, nil)
	other := filepath.Join(s.root, "unrelated")
	for _, name := range []string{exeName, uninstaller, markerName} {
		put(t, filepath.Join(other, name), contents(t, filepath.Join(s.dir, name)))
	}
	put(t, filepath.Join(other, "personal.txt"), "keep")
	for _, copied := range []bool{false, true} {
		if copied {
			put(t, filepath.Join(other, receiptName), contents(t, filepath.Join(s.dir, receiptName)))
		}
		before := snapshot(t, other)
		if install(s.self, other, "2", s.shell) == nil || uninstall(s.self, other, s.shell, false) == nil || !maps.Equal(before, snapshot(t, other)) {
			t.Fatal("unowned directory accepted or changed")
		}
	}
}

func TestNativeUpgradeCollisionAndModifiedOwnedFile(t *testing.T) {
	s := disposable(t)
	s.installed(t, map[string]string{"z.txt": "owned"})
	put(t, filepath.Join(s.dir, "personal.txt"), "mine")
	before := snapshot(t, s.dir)
	s.payload(t, "2", map[string]string{"personal.txt": "new payload", "added/first": "new"})
	if err := install(s.self, s.dir, "2", s.shell); err == nil || !maps.Equal(before, snapshot(t, s.dir)) {
		t.Fatalf("collision: %v", err)
	}
	put(t, filepath.Join(s.dir, "z.txt"), "my edited version")
	before = snapshot(t, s.dir)
	if err := s.remove(); err == nil || !maps.Equal(before, snapshot(t, s.dir)) {
		t.Fatalf("modified installed file: %v", err)
	}
	s.clean(t)
}

func TestNativeRollbackOnLockedFileAndIntegrationFailure(t *testing.T) {
	s := disposable(t)
	s.installed(t, map[string]string{"z-last": "must survive"})
	s.payload(t, "2", map[string]string{"new/partial": "new"})
	before := snapshot(t, s.dir)
	lock, err := syscall.CreateFile(winPath(filepath.Join(s.dir, "z-last")), syscall.GENERIC_READ, syscall.FILE_SHARE_READ, nil, syscall.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, operation := range []func() error{func() error { return install(s.self, s.dir, "2", s.shell) }, s.remove} {
		if err := operation(); !errors.Is(err, syscall.Errno(32)) || !maps.Equal(before, snapshot(t, s.dir)) {
			syscall.CloseHandle(lock)
			t.Fatalf("sharing violation did not restore original: %v", err)
		}
	}
	syscall.CloseHandle(lock)
	fail := errors.New("simulated shell failure")
	working := s.shell
	s.shell.install = func(string, string, uint64, bool) error { return fail }
	s.shell.uninstall = func(string) error { return fail }
	for _, operation := range []func() error{func() error { return install(s.self, s.dir, "2", s.shell) }, s.remove} {
		if err := operation(); !errors.Is(err, fail) || !maps.Equal(before, snapshot(t, s.dir)) {
			t.Fatalf("integration rollback: %v", err)
		}
		s.clean(t)
	}
	s.shell = working
	if err := s.remove(); err != nil {
		t.Fatalf("restored installation is no longer usable: %v", err)
	}
}

func TestNativeReplacedEmptyDirectoryIsNotOwned(t *testing.T) {
	s := disposable(t)
	s.installed(t, map[string]string{"mine/owned": "first"})
	child := filepath.Join(s.dir, "mine")
	if err := os.Rename(child, filepath.Join(s.root, "original-child")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(child, 0700); err != nil {
		t.Fatal(err)
	}
	before := snapshot(t, s.dir)
	if err := s.remove(); err == nil || !strings.Contains(err.Error(), "not the one recorded") || !maps.Equal(before, snapshot(t, s.dir)) {
		t.Fatalf("replacement directory: %v", err)
	}
	s.clean(t)
}

func TestNativeFailedRollbackRetainsBothVersions(t *testing.T) {
	s := disposable(t)
	s.installed(t, nil)
	s.payload(t, "2", nil)
	s.shell.install = func(string, string, uint64, bool) error {
		put(t, filepath.Join(s.dir, exeName), "concurrent change")
		return errors.New("simulated shell failure")
	}
	err := install(s.self, s.dir, "2", s.shell)
	if err == nil || !strings.Contains(err.Error(), "recovery files retained") || contents(t, filepath.Join(s.dir, exeName)) != "concurrent change" {
		t.Fatalf("rollback conflict: %v", err)
	}
	matches, err := filepath.Glob(filepath.Join(s.root, ".grokbot-transaction-*", "previous", exeName))
	if err != nil || len(matches) != 1 || contents(t, matches[0]) != "synthetic client 1" {
		t.Fatal("previous file not retained for recovery")
	}
}

func TestNativeFailedFreshInstallRestoresAbsentOrEmptyDestination(t *testing.T) {
	for _, existing := range []bool{false, true} {
		s := disposable(t)
		s.dir = filepath.Join(s.root, "parent", "nested", "install")
		if existing {
			if err := os.MkdirAll(s.dir, 0700); err != nil {
				t.Fatal(err)
			}
		}
		s.payload(t, "1", map[string]string{"nested/data": "partial"})
		fail := errors.New("simulated registration failure")
		s.shell.install = func(string, string, uint64, bool) error { return fail }
		before := snapshot(t, s.root)
		if err := install(s.self, s.dir, "1", s.shell); !errors.Is(err, fail) || !maps.Equal(before, snapshot(t, s.root)) {
			t.Fatalf("fresh install rollback (existing=%v): %v", existing, err)
		}
	}
}

func TestNativeTransactionDoesNotAdmitAnotherInstaller(t *testing.T) {
	s := disposable(t)
	s.payload(t, "1", nil)
	s.shell.install = func(string, string, uint64, bool) error {
		err := changeInstallation(s.dir, nil, func(bool) error { t.Fatal("nested integration called"); return nil })
		if err == nil || !strings.Contains(err.Error(), "could not reserve") {
			t.Fatalf("unexpected nested operation: %v", err)
		}
		return nil
	}
	if err := install(s.self, s.dir, "1", s.shell); err != nil {
		t.Fatal(err)
	}
	if err := s.remove(); err != nil {
		t.Fatal(err)
	}
	s.clean(t)
}

func TestNativeCorruptPayloadDoesNotPublishPartialFiles(t *testing.T) {
	s := disposable(t)
	s.installed(t, nil)
	before := snapshot(t, s.dir)
	s.payload(t, "2", map[string]string{"z-last": "unique checksum fixture"})
	data := contents(t, s.self)
	put(t, s.self, strings.Replace(data, "unique checksum fixture", "wrong! checksum fixture", 1))
	if err := install(s.self, s.dir, "2", s.shell); !errors.Is(err, zip.ErrChecksum) || !maps.Equal(before, snapshot(t, s.dir)) {
		t.Fatalf("damaged archive: %v", err)
	}
	s.clean(t)
}

func TestNativeJunctionsAreNotInstallLocations(t *testing.T) {
	s := disposable(t)
	s.installed(t, nil)
	link := filepath.Join(s.root, "alias")
	// Directory junctions do not require symlink privileges; both ends are in
	// the verified disposable root. No registry or shell integration is invoked.
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; New-Item -ItemType Junction -Path $env:GB_TEST_LINK -Target $env:GB_TEST_TARGET | Out-Null`)
	cmd.Env = append(os.Environ(), "GB_TEST_LINK="+link, "GB_TEST_TARGET="+s.dir)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("create test junction: %v: %s", err, output)
	}
	t.Cleanup(func() { os.Remove(link) })
	before := snapshot(t, s.dir)
	if install(s.self, filepath.Join(link, "child"), "2", s.shell) == nil || uninstall(s.self, link, s.shell, false) == nil || !maps.Equal(before, snapshot(t, s.dir)) {
		t.Fatal("junction target changed")
	}
}
