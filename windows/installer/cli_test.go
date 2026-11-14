//go:build windows

package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// This entry point exists only in the Go test executable, never in the shipped
// stub. The installed copy and its worker inherit the same confined shell hooks.
func TestMain(m *testing.M) {
	if root := os.Getenv("PROKBOT_INSTALLER_FIXTURE_ROOT"); root != "" {
		if err := fixtureCLI(root); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	os.Exit(m.Run())
}

func fixtureCLI(root string) error {
	workerDir := filepath.Join(root, "worker-temp")
	dir := filepath.Join(root, "installation with spaces")
	if err := checkLocation(root); err != nil {
		return err
	}
	if _, err := plainPath(workerDir); err != nil {
		return err
	}
	token, err := os.ReadFile(filepath.Join(root, "fixture-token"))
	if err != nil || len(token) == 0 || string(token) != os.Getenv("PROKBOT_INSTALLER_FIXTURE_TOKEN") || !strings.EqualFold(os.TempDir(), workerDir) {
		return fmt.Errorf("invalid disposable CLI fixture")
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	args := os.Args[1:]
	setup := self == filepath.Join(root, "setup.exe") && slices.Equal(args, []string{"/S", "/D=" + dir})
	installed := self == filepath.Join(dir, uninstaller) && slices.Equal(args, []string{"/S"})
	worker := filepath.Dir(self) == workerDir && slices.Equal(args, []string{"--uninstall-from", dir, "/S"})
	if !setup && !installed && !worker {
		return fmt.Errorf("refusing CLI invocation outside fixture")
	}
	windowsShell = shellIntegration{
		install: func(target, version string, _ uint64, fresh bool) error {
			if target != dir || (version != "1" && version != "2") {
				return fmt.Errorf("unexpected fixture install")
			}
			return os.WriteFile(filepath.Join(root, "shell-install-"+version), []byte(fmt.Sprint(fresh)), 0600)
		},
		uninstall: func(target string) error {
			if target != dir || !worker {
				return fmt.Errorf("unexpected fixture uninstall")
			}
			return os.WriteFile(filepath.Join(root, "shell-uninstalled"), []byte("worker"), 0600)
		},
	}
	main()
	return nil
}

func TestNativeCLISilentInstallUpgradeAndWorkerUninstall(t *testing.T) {
	s := disposable(t)
	dir := filepath.Join(s.root, "installation with spaces")
	setup := filepath.Join(s.root, "setup.exe")
	workerDir := filepath.Join(s.root, "worker-temp")
	if err := os.Mkdir(workerDir, 0700); err != nil {
		t.Fatal(err)
	}
	token := rand.Text()
	put(t, filepath.Join(s.root, "fixture-token"), token)
	testExe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	head, err := os.ReadFile(testExe)
	if err != nil {
		t.Fatal(err)
	}
	run := func(exe string, args ...string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, exe, args...)
		cmd.Dir = s.root
		cmd.Env = append(os.Environ(), "TMP="+workerDir, "TEMP="+workerDir,
			"PROKBOT_INSTALLER_FIXTURE_ROOT="+s.root, "PROKBOT_INSTALLER_FIXTURE_TOKEN="+token)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("fixture CLI: %v: %s", err, output)
		}
	}
	for _, version := range []string{"1", "2"} {
		s.payload(t, version, nil)
		p, err := readPayload(s.self)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(io.NewSectionReader(p.file, p.offset, p.size))
		p.file.Close()
		if err != nil {
			t.Fatal(err)
		}
		var footer [footerLength]byte
		binary.LittleEndian.PutUint64(footer[:], uint64(len(head)))
		binary.LittleEndian.PutUint64(footer[8:], uint64(len(body)))
		copy(footer[16:], footerMagic)
		if err := os.WriteFile(setup, bytes.Join([][]byte{head, body, footer[:]}, nil), 0700); err != nil {
			t.Fatal(err)
		}
		run(setup, "/S", "/D="+dir)
		if version == "1" {
			put(t, filepath.Join(dir, "personal"), "keep")
		}
		if contents(t, filepath.Join(dir, exeName)) != "synthetic client "+version || contents(t, filepath.Join(s.root, "shell-install-"+version)) != fmt.Sprint(version == "1") {
			t.Fatal("version or integration mismatch")
		}
	}
	run(filepath.Join(dir, uninstaller), "/S")
	deadline := time.Now().Add(20 * time.Second)
	for {
		_, markerErr := os.Stat(filepath.Join(s.root, "shell-uninstalled"))
		copies, err := os.ReadDir(workerDir)
		if err != nil {
			t.Fatal(err)
		}
		if markerErr == nil && len(copies) == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("uninstall worker or its cleanup did not finish: marker=%v, copies=%d", markerErr, len(copies))
		}
		time.Sleep(50 * time.Millisecond)
	}
	left := snapshot(t, dir)
	if len(left) != 1 || left["personal"] != "keep" {
		t.Fatalf("uninstall did not preserve only the personal file: %#v", left)
	}
	s.clean(t)
}
