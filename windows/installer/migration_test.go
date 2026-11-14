//go:build windows

package main

import (
	"context"
	"errors"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func legacyFixture(t *testing.T, s *sandbox) (old, next, profile string) {
	t.Helper()
	old = filepath.Join(s.root, "baseline client")
	next = siblingDirectory(old)
	profile = filepath.Join(os.Getenv("APPDATA"), appName)
	put(t, filepath.Join(old, exeName), "original client placeholder")
	put(t, filepath.Join(old, uninstaller), "baseline stub placeholder")
	put(t, filepath.Join(old, markerName), `{"appUserModelId":"dev.grokbot.local","version":"0.71.2"}`)
	put(t, filepath.Join(old, "resources", "personal", "notes"), "not installer-owned")
	put(t, filepath.Join(profile, "settings.json"), `{"language":"en"}`)
	return
}

func TestLegacyMigrationUsesOnlyNewPayloadAndPreservesSharedProfile(t *testing.T) {
	s := disposable(t)
	old, next, profile := legacyFixture(t, s)
	baseline, settings := snapshot(t, old), snapshot(t, profile)
	s.payload(t, "1", nil)
	err := installEntry(s.self, old, "1", s.shell, false)
	if err == nil || !strings.Contains(err.Error(), "--migrate-legacy") || !strings.Contains(err.Error(), next) {
		t.Fatalf("silent install must give an actionable alternative: %v", err)
	}
	if _, err := os.Stat(next); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("side-by-side install was not explicitly selected")
	}
	for _, version := range []string{"1", "2", "3"} {
		s.payload(t, version, nil)
		target, migrate := old, true
		if version == "3" {
			target, migrate = next, false // A direct upgrade must also retain isolation.
		}
		if err := installEntry(s.self, target, version, s.shell, migrate); err != nil {
			t.Fatal(err)
		}
		r, _, err := inspectDirectory(next, false)
		if err != nil || r.LegacyFrom != old || contents(t, filepath.Join(next, exeName)) != "synthetic client "+version {
			t.Fatalf("managed sibling or payload mismatch: %v", err)
		}
		if _, err := os.Lstat(filepath.Join(next, "resources", "personal")); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("legacy contents were copied into the new install")
		}
	}
	put(t, filepath.Join(next, "keep"), "new user file")
	if err := uninstall(s.self, old, s.shell, false); err == nil {
		t.Fatal("legacy uninstall was allowed")
	}
	if err := uninstall(s.self, next, s.shell, false); err != nil {
		t.Fatal(err)
	}
	if !maps.Equal(snapshot(t, old), baseline) || !maps.Equal(snapshot(t, profile), settings) || !maps.Equal(snapshot(t, next), map[string]string{"keep": "new user file"}) || len(s.installs) != 0 || s.uninstalls != 0 {
		t.Fatal("side-by-side lifecycle changed legacy files, shared profile or shell registration")
	}
}

func TestLegacyMigrationRefusesOccupiedSiblingAndInvalidSource(t *testing.T) {
	s := disposable(t)
	old, next, _ := legacyFixture(t, s)
	s.payload(t, "1", nil)
	put(t, filepath.Join(next, "keep"), "preexisting")
	before := snapshot(t, s.root)
	if err := installEntry(s.self, old, "1", s.shell, true); err == nil || !maps.Equal(before, snapshot(t, s.root)) {
		t.Fatalf("unowned sibling accepted or changed: %v", err)
	}
	if err := os.Remove(filepath.Join(next, "keep")); err != nil {
		t.Fatal(err)
	}
	s.dir = next
	s.installed(t, nil) // A valid regular install is not this migration's sibling.
	before = snapshot(t, s.root)
	if err := installEntry(s.self, old, "2", s.shell, true); err == nil || !maps.Equal(before, snapshot(t, s.root)) {
		t.Fatalf("unrelated managed installation accepted or changed: %v", err)
	}
	for _, source := range []string{next, filepath.Join(s.root, "absent")} {
		if err := installEntry(s.self, source, "1", s.shell, true); err == nil {
			t.Fatal("migration accepted a non-legacy source")
		}
	}
	put(t, filepath.Join(old, receiptName), "damaged")
	if err := installEntry(s.self, old, "1", s.shell, true); err == nil {
		t.Fatal("damaged receipt treated as a legacy installation")
	}
}

// Opt-in only: use the actual generated candidate, not an official installer.
// Compare the embedded executable to this repo's stub before running it. Only
// the no-shell side-by-side commands are permitted; never launch the client.
func TestGeneratedCandidateLegacyMigration(t *testing.T) {
	setup := os.Getenv("PROKBOT_WINDOWS_TEST_CANDIDATE")
	if setup == "" {
		t.Skip("set PROKBOT_WINDOWS_TEST_CANDIDATE to the generated setup")
	}
	s := disposable(t)
	old, next, profile := legacyFixture(t, s)
	baseline, settings := snapshot(t, old), snapshot(t, profile)
	stub, err := filepath.Abs("../dist/installer/grokbot-setup-stub.exe")
	if err != nil {
		t.Fatal(err)
	}
	stubBytes := contents(t, stub)
	p, err := readPayload(setup)
	if err != nil {
		t.Fatal(err)
	}
	version, ok := embeddedVersion(p)
	if p.offset != int64(len(stubBytes)) || !ok {
		p.file.Close()
		t.Fatal("not a generated candidate with the current stub")
	}
	head := make([]byte, len(stubBytes))
	_, err = p.file.ReadAt(head, 0)
	p.file.Close()
	if err != nil || string(head) != stubBytes {
		t.Fatal("candidate stub bytes differ from the current build")
	}
	workerTemp := filepath.Join(s.root, "temp")
	if err := os.Mkdir(workerTemp, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMP", workerTemp)
	t.Setenv("TEMP", workerTemp)
	run := func(exe string, args ...string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		cmd := exec.CommandContext(ctx, exe, args...)
		cmd.Dir = s.root
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("candidate CLI: %v: %s", err, output)
		}
	}
	for i := 0; i < 2; i++ {
		run(setup, "/S", "--migrate-legacy", "/D="+old)
		r, _, err := inspectDirectory(next, false)
		if err != nil || r.LegacyFrom != old || contents(t, filepath.Join(next, uninstaller)) != stubBytes {
			t.Fatalf("candidate did not publish the expected managed sibling: %v", err)
		}
		for _, name := range []string{exeName, "resources/app.asar"} {
			portable := filepath.Join(filepath.Dir(setup), appName, name)
			digest, err := fileDigest(portable)
			if err != nil || verifyFile(filepath.Join(next, name), digest) != nil {
				t.Fatalf("installed %s does not match the built portable", name)
			}
		}
		t.Logf("candidate %s, pass %d: %d receipt files", version, i+1, len(r.Files))
		put(t, filepath.Join(next, "keep.txt"), "personal")
	}
	run(filepath.Join(next, uninstaller), "/S")
	deadline := time.Now().Add(90 * time.Second)
	for {
		_, err := os.Lstat(filepath.Join(next, receiptName))
		copies, readErr := os.ReadDir(workerTemp)
		if errors.Is(err, os.ErrNotExist) && readErr == nil && len(copies) == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("candidate uninstaller or temporary worker did not finish")
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !maps.Equal(snapshot(t, next), map[string]string{"keep.txt": "personal"}) || !maps.Equal(snapshot(t, old), baseline) || !maps.Equal(snapshot(t, profile), settings) {
		t.Fatal("candidate changed personal files, legacy layout or shared profile")
	}
	s.clean(t)
}
