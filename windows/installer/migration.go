//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const sideBySideSuffix = " (side-by-side)"

func siblingDirectory(dir string) string { return dir + sideBySideSuffix }

// These are exactly the baseline's identifying files, not an ownership list.
// Nothing in the old folder or shared userData is copied, executed or modified.
func legacyDirectory(dir string) bool {
	if checkLocation(dir) != nil {
		return false
	}
	if _, err := plainPath(filepath.Join(dir, receiptName)); !errors.Is(err, os.ErrNotExist) {
		return false
	}
	for _, name := range []string{exeName, uninstaller} {
		info, err := plainPath(filepath.Join(dir, name))
		if err != nil || !info.Mode().IsRegular() {
			return false
		}
	}
	return checkMarker(dir) == nil
}

type legacyInstallation string

func (e legacyInstallation) Error() string {
	dir := string(e)
	return fmt.Sprintf(text("旧安装没有文件归属记录，不会替换或卸载：%s\n新目录：%s\n请退出旧客户端，并用新安装包运行：--migrate-legacy \"/D=%s\"",
		"Legacy installation has no ownership receipt; it will not be replaced or uninstalled: %s\nNew directory: %s\nQuit the old client, then run the new setup with: --migrate-legacy \"/D=%s\""), dir, siblingDirectory(dir), dir)
}

type installOptions struct{ legacy string }

func installEntry(self, dir, version string, shell shellIntegration, migrate bool) error {
	if !migrate {
		err := install(self, dir, version, shell)
		var legacy legacyInstallation
		if !errors.As(err, &legacy) || silent {
			return err
		}
		if !ask(fmt.Sprintf(text("保留旧安装 %s，在旁边安装新版本到 %s？\n两者共用已有的配对和设置，请先退出旧客户端。",
			"Keep the old installation at %s and install the new version alongside it at %s?\nBoth use the existing pairing and settings. Quit the old client first."), dir, siblingDirectory(dir)), mbIconInfo|mbDefButton2) {
			return nil
		}
	}
	if !legacyDirectory(dir) {
		return fmt.Errorf("not a marker-only legacy installation: %s; /D= must name the old installation", dir)
	}
	return installTo(self, siblingDirectory(dir), version, shell, installOptions{legacy: dir})
}

func (o installOptions) checkTarget(dir string, old *receipt) error {
	if o.legacy == "" {
		return nil
	}
	if !strings.EqualFold(dir, siblingDirectory(o.legacy)) || (old != nil && !strings.EqualFold(old.LegacyFrom, o.legacy)) {
		return fmt.Errorf("destination is not the side-by-side installation for %s: %s", o.legacy, dir)
	}
	return nil
}
