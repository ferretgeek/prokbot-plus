//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDirectoryOwnership(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "installation")
	check := func(install, want bool) {
		t.Helper()
		if err := checkDirectory(dir, install); (err == nil) != want {
			t.Fatalf("install=%v want=%v error=%v", install, want, err)
		}
	}
	check(true, true)
	check(false, false)
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	check(true, true)
	check(false, false)
	put := func(name, data string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	put("personal.txt", "keep")
	check(true, false)
	put(exeName, "official")
	check(false, false)
	put(uninstaller, "stub")
	check(true, false)
	if err := os.Mkdir(filepath.Join(dir, "resources"), 0700); err != nil {
		t.Fatal(err)
	}
	put("resources/grokbot-local.patch.json", `{}`)
	check(false, false)
	put("resources/grokbot-local.patch.json", `{"appUserModelId":"dev.grokbot.local"}`)
	check(true, true)
	check(false, true)
	for _, invalid := range []string{".", "", filepath.VolumeName(dir) + `\`} {
		if err := checkDirectory(invalid, true); err == nil {
			t.Fatalf("accepted %q", invalid)
		}
	}
}
