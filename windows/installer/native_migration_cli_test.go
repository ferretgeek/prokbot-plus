//go:build windows

package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// Run only in a disposable Windows VM/runner, with TMP and TEMP set to private
// scratch before go test. The real stub has no shell mocks; /D= does not isolate HKCU.
func TestNativeStubLegacyMigrationFromInstallDirectory(t *testing.T) {
	if os.Getenv("PROKBOT_INSTALLER_DISPOSABLE_WINDOWS") != "1" {
		t.Skip("requires an explicitly disposable Windows environment")
	}
	s := disposable(t)
	old, next, profile := legacyFixture(t, s)
	baseline, settings := snapshot(t, old), snapshot(t, profile)
	checkBaseline := func() {
		t.Helper()
		if !maps.Equal(snapshot(t, old), baseline) || !maps.Equal(snapshot(t, profile), settings) {
			t.Fatal("legacy installation or fixture profile changed")
		}
	}
	stub := filepath.Join(s.root, "stub.exe")
	build := exec.Command("go", "build", "-buildvcs=false", "-mod=readonly", "-trimpath", "-ldflags=-H=windowsgui -s -w", "-o", stub, ".")
	build.Env = append(os.Environ(), "GOENV=off", "GOFLAGS=", "GOWORK=off", "GOTOOLCHAIN=local", "GOPROXY=off")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build installer stub: %v: %s", err, output)
	}
	head := []byte(contents(t, stub))
	workerTemp := filepath.Join(s.root, "worker-temp")
	if err := os.Mkdir(workerTemp, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMP", workerTemp)
	t.Setenv("TEMP", workerTemp)
	run := func(cwd, exe string, args ...string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, exe, args...)
		cmd.Dir = cwd
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%s: %v: %s", filepath.Base(exe), err, output)
		}
	}

	setup := filepath.Join(s.root, "setup.exe")
	personal := filepath.Join(next, "personal.txt")
	for _, version := range []string{"1", "2"} {
		s.payload(t, version, nil)
		// Replace only the synthetic stub and its offset; keep the fixture ZIP and size.
		data := []byte(contents(t, s.self))
		footer := data[len(data)-footerLength:]
		offset := binary.LittleEndian.Uint64(footer)
		binary.LittleEndian.PutUint64(footer, uint64(len(head)))
		if err := os.WriteFile(setup, bytes.Join([][]byte{head, data[offset:]}, nil), 0700); err != nil {
			t.Fatal(err)
		}
		if version == "1" {
			run(s.root, setup, "/S", "--migrate-legacy", "/D="+old)
		} else {
			run(s.root, setup, "/S", "/D="+next)
		}
		r, _, err := inspectDirectory(next, false)
		if err != nil {
			t.Fatal(err)
		}
		if !r.CreatedRoot || r.LegacyFrom != old || contents(t, filepath.Join(next, exeName)) != "synthetic client "+version || contents(t, filepath.Join(next, uninstaller)) != string(head) {
			t.Fatalf("version %s was not published as the expected managed sibling", version)
		}
		if version == "1" {
			put(t, personal, "keep across upgrade")
		} else if contents(t, personal) != "keep across upgrade" {
			t.Fatal("upgrade changed a personal file")
		}
		checkBaseline()
	}
	if err := os.Remove(personal); err != nil { // Leave only installer-owned files before testing root removal.
		t.Fatal(err)
	}

	// Only the uninstaller starts inside the managed root. Its parent exiting
	// successfully does not establish that the temporary worker removed the root.
	run(next, filepath.Join(next, uninstaller), "/S")
	deadline := time.Now().Add(30 * time.Second)
	for {
		_, err := os.Lstat(next)
		entries, readErr := os.ReadDir(workerTemp)
		if readErr != nil {
			t.Fatal(readErr)
		}
		if errors.Is(err, os.ErrNotExist) && len(entries) == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("uninstall incomplete: managed root stat=%v, worker temp entries=%v", err, entries)
		}
		time.Sleep(50 * time.Millisecond)
	}
	checkBaseline()
	s.clean(t)
}
