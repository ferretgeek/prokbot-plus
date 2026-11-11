//go:build windows

// Per-user installer for the patched Windows client. The patcher appends a zip of the
// application directory and a footer to this stub; the same executable, without the
// payload, is installed as the uninstaller. Only the Go standard library is used.
package main

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	appName      = "Grok Bot Local"
	exeName      = "Grok Bot.exe"
	uninstaller  = "Uninstall Grok Bot Local.exe"
	registryKey  = `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\GrokBotLocal`
	footerMagic  = "GROKBOT-SETUP-V1"
	footerLength = 8 + 8 + 16
)

var (
	user32           = syscall.NewLazyDLL("user32.dll")
	kernel32         = syscall.NewLazyDLL("kernel32.dll")
	messageBox       = user32.NewProc("MessageBoxW")
	createWindow     = user32.NewProc("CreateWindowExW")
	destroyWindow    = user32.NewProc("DestroyWindow")
	peekMessage      = user32.NewProc("PeekMessageW")
	translateMessage = user32.NewProc("TranslateMessage")
	dispatchMessage  = user32.NewProc("DispatchMessageW")
	setWindowText    = user32.NewProc("SetWindowTextW")
	systemMetrics    = user32.NewProc("GetSystemMetrics")
	uiLanguage       = kernel32.NewProc("GetUserDefaultUILanguage")
	regGetValue      = syscall.NewLazyDLL("advapi32.dll").NewProc("RegGetValueW")
	silent           bool
	chinese          bool
)

func text(zh, en string) string {
	if chinese {
		return zh
	}
	return en
}

const (
	mbOK          = 0x0
	mbYesNo       = 0x4
	mbIconInfo    = 0x40
	mbIconWarning = 0x30
	mbIconError   = 0x10
	mbDefButton2  = 0x100
	idYes         = 6
)

func ask(message string, flags uintptr) bool {
	if silent {
		return flags&mbDefButton2 == 0
	}
	title, _ := syscall.UTF16PtrFromString(appName)
	body, _ := syscall.UTF16PtrFromString(message)
	result, _, _ := messageBox.Call(0, uintptr(unsafe.Pointer(body)), uintptr(unsafe.Pointer(title)), flags|mbYesNo)
	return result == idYes
}

func tell(message string, flags uintptr) {
	if silent {
		fmt.Fprintln(os.Stderr, message)
		return
	}
	title, _ := syscall.UTF16PtrFromString(appName)
	body, _ := syscall.UTF16PtrFromString(message)
	messageBox.Call(0, uintptr(unsafe.Pointer(body)), uintptr(unsafe.Pointer(title)), flags)
}

// progress shows a small borderless status window while files are written.
type progress struct{ window uintptr }

func showProgress(message string) *progress {
	if silent {
		return &progress{}
	}
	class, _ := syscall.UTF16PtrFromString("STATIC")
	body, _ := syscall.UTF16PtrFromString(message)
	width, height := uintptr(420), uintptr(90)
	screenWidth, _, _ := systemMetrics.Call(0)
	screenHeight, _, _ := systemMetrics.Call(1)
	const style = 0x80000000 | 0x10000000 | 0x00800000 | 0x1 | 0x200 // popup, visible, border, center, centerimage
	window, _, _ := createWindow.Call(0x8|0x80, uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(body)), style,
		(screenWidth-width)/2, (screenHeight-height)/2, width, height, 0, 0, 0, 0)
	p := &progress{window: window}
	p.pump()
	return p
}

func (p *progress) set(message string) {
	if p.window == 0 {
		return
	}
	body, _ := syscall.UTF16PtrFromString(message)
	setWindowText.Call(p.window, uintptr(unsafe.Pointer(body)))
	p.pump()
}

func (p *progress) pump() {
	var msg [48]byte
	for {
		found, _, _ := peekMessage.Call(uintptr(unsafe.Pointer(&msg[0])), 0, 0, 0, 1)
		if found == 0 {
			return
		}
		translateMessage.Call(uintptr(unsafe.Pointer(&msg[0])))
		dispatchMessage.Call(uintptr(unsafe.Pointer(&msg[0])))
	}
}

func (p *progress) close() {
	if p.window != 0 {
		destroyWindow.Call(p.window)
		p.window = 0
	}
}

type payload struct {
	file   *os.File
	offset int64
	size   int64
}

func readPayload(path string) (*payload, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || info.Size() < footerLength {
		file.Close()
		return nil, errors.New("installer payload missing")
	}
	footer := make([]byte, footerLength)
	if _, err := file.ReadAt(footer, info.Size()-footerLength); err != nil || string(footer[16:]) != footerMagic {
		file.Close()
		return nil, errors.New("installer payload missing")
	}
	offset, size := int64(binary.LittleEndian.Uint64(footer)), int64(binary.LittleEndian.Uint64(footer[8:]))
	if offset <= 0 || size <= 0 || offset+size+footerLength != info.Size() {
		file.Close()
		return nil, errors.New("installer payload is damaged")
	}
	return &payload{file: file, offset: offset, size: size}, nil
}

func defaultDirectory() string {
	return filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", appName)
}

func startMenuShortcut() string {
	return filepath.Join(os.Getenv("APPDATA"), `Microsoft\Windows\Start Menu\Programs`, appName+".lnk")
}

// A portable or official client is not an installation owned by this uninstaller.
func checkDirectory(directory string, installing bool) error {
	directory = filepath.Clean(directory)
	if !filepath.IsAbs(directory) || filepath.Dir(directory) == directory {
		return fmt.Errorf("invalid installation directory: %s", directory)
	}
	info, err := os.Lstat(directory)
	if installing && errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("not an installation directory: %s", directory)
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	if installing && len(entries) == 0 {
		return nil
	}
	for _, name := range []string{exeName, uninstaller} {
		f, err := os.Lstat(filepath.Join(directory, name))
		if err != nil || !f.Mode().IsRegular() {
			return fmt.Errorf("not a Grok Bot Local installation: %s", directory)
		}
	}
	var marker struct {
		AppUserModelID string `json:"appUserModelId"`
	}
	data, err := os.ReadFile(filepath.Join(directory, "resources", "grokbot-local.patch.json"))
	if err != nil || json.Unmarshal(data, &marker) != nil || marker.AppUserModelID != "dev.grokbot.local" {
		return fmt.Errorf("unrecognized Grok Bot Local installation: %s", directory)
	}
	return nil
}

// inUse reports whether the installed client is running: Windows refuses to rename a
// directory that contains a loaded executable.
func inUse(directory string) bool {
	if _, err := os.Stat(directory); err != nil {
		return false
	}
	probe := directory + ".probe"
	if err := os.Rename(directory, probe); err != nil {
		return true
	}
	return os.Rename(probe, directory) != nil
}

// waitUntilClosed asks the user to quit a running client; silent runs fail instead of waiting.
func waitUntilClosed(directory string) bool {
	// A relaunched uninstaller starts while its parent is still exiting from the same folder.
	for attempt := 0; attempt < 30 && inUse(directory); attempt++ {
		time.Sleep(500 * time.Millisecond)
	}
	for inUse(directory) {
		if silent {
			tell(text("Grok Bot Local 正在运行，请先退出。", "Grok Bot Local is running. Quit it first."), mbIconError)
			os.Exit(3)
		}
		if !ask(text("Grok Bot Local 正在运行。请在通知区域图标菜单中选择“退出”，然后点“是”继续。",
			"Grok Bot Local is running. Choose Quit from its notification-area icon, then select Yes to continue."), mbIconWarning) {
			return false
		}
	}
	return true
}

func extract(data *payload, target string, report func(done, total int)) (uint64, error) {
	reader, err := zip.NewReader(io.NewSectionReader(data.file, data.offset, data.size), data.size)
	if err != nil {
		return 0, err
	}
	var written uint64
	// The payload is also the portable archive: everything sits under one top folder.
	prefix := appName + "/"
	for index, entry := range reader.File {
		if !strings.HasPrefix(entry.Name, prefix) {
			return 0, fmt.Errorf("unexpected payload path %q", entry.Name)
		}
		name := filepath.FromSlash(strings.TrimPrefix(entry.Name, prefix))
		if name == "" {
			continue
		}
		if !filepath.IsLocal(name) {
			return 0, fmt.Errorf("unsafe payload path %q", entry.Name)
		}
		destination := filepath.Join(target, name)
		if strings.HasSuffix(entry.Name, "/") {
			if err := os.MkdirAll(destination, 0o755); err != nil {
				return 0, err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
			return 0, err
		}
		source, err := entry.Open()
		if err != nil {
			return 0, err
		}
		output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err != nil {
			source.Close()
			return 0, err
		}
		count, copyErr := io.Copy(output, source)
		source.Close()
		if closeErr := output.Close(); copyErr == nil {
			copyErr = closeErr
		}
		if copyErr != nil {
			return 0, copyErr
		}
		written += uint64(count)
		report(index+1, len(reader.File))
	}
	return written, nil
}

func run(name string, args ...string) error {
	command := exec.Command(name, args...)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	output, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %v: %s", name, err, bytes.TrimSpace(output))
	}
	return nil
}

func registry(directory string, version string, size uint64) error {
	self := filepath.Join(directory, uninstaller)
	values := [][3]string{
		{"DisplayName", "REG_SZ", appName},
		{"DisplayVersion", "REG_SZ", version},
		{"Publisher", "REG_SZ", "ProkBot (self-hosted Grok Bot)"},
		{"InstallLocation", "REG_SZ", directory},
		{"DisplayIcon", "REG_SZ", filepath.Join(directory, exeName) + ",0"},
		{"UninstallString", "REG_SZ", `"` + self + `" --uninstall`},
		{"QuietUninstallString", "REG_SZ", `"` + self + `" --uninstall /S`},
		{"NoModify", "REG_DWORD", "1"},
		{"NoRepair", "REG_DWORD", "1"},
		{"EstimatedSize", "REG_DWORD", fmt.Sprint(size / 1024)},
	}
	for _, value := range values {
		if err := run("reg.exe", "add", registryKey, "/v", value[0], "/t", value[1], "/d", value[2], "/f"); err != nil {
			return err
		}
	}
	return nil
}

// Shortcuts are written by the shell's own COM object; paths travel in the environment.
func shortcuts(directory string, desktop bool) error {
	script := `$shell = New-Object -ComObject WScript.Shell
$targets = @($env:GB_START_MENU)
if ($env:GB_DESKTOP -eq '1') { $targets += Join-Path ([Environment]::GetFolderPath('Desktop')) 'Grok Bot Local.lnk' }
foreach ($path in $targets) {
  $link = $shell.CreateShortcut($path)
  $link.TargetPath = $env:GB_TARGET
  $link.WorkingDirectory = $env:GB_DIRECTORY
  $link.IconLocation = "$($env:GB_TARGET),0"
  $link.Description = 'Grok Bot Local'
  $link.Save()
}`
	command := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	flag := "0"
	if desktop {
		flag = "1"
	}
	command.Env = append(os.Environ(), "GB_START_MENU="+startMenuShortcut(), "GB_DESKTOP="+flag,
		"GB_TARGET="+filepath.Join(directory, exeName), "GB_DIRECTORY="+directory)
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("shortcuts: %v: %s", err, bytes.TrimSpace(output))
	}
	return nil
}

// removeIntegration deletes shortcuts and the link handler only when they point into
// this installation; a portable copy elsewhere keeps its own.
func removeIntegration(directory string) error {
	script := `$shell = New-Object -ComObject WScript.Shell
$root = $env:GB_DIRECTORY.TrimEnd('\') + '\'
foreach ($path in @($env:GB_START_MENU, (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Grok Bot Local.lnk'))) {
  if ((Test-Path -LiteralPath $path) -and $shell.CreateShortcut($path).TargetPath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $path -Force
  }
}
$handler = 'HKCU:\Software\Classes\grokbot-local'
$command = (Get-ItemProperty -LiteralPath "$handler\shell\open\command" -ErrorAction SilentlyContinue).'(default)'
if ($command -and $command.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0) { Remove-Item -LiteralPath $handler -Recurse -Force }`
	command := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	command.Env = append(os.Environ(), "GB_START_MENU="+startMenuShortcut(), "GB_DIRECTORY="+directory)
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("shortcuts: %v: %s", err, bytes.TrimSpace(output))
	}
	return nil
}

func install(self string, directory string, version string) error {
	if err := checkDirectory(directory, true); err != nil {
		return err
	}
	data, err := readPayload(self)
	if err != nil {
		return err
	}
	defer data.file.Close()
	if !ask(text(fmt.Sprintf("安装 %s %s 到：\n%s\n\n已有的配对和设置会保留。", appName, version, directory),
		fmt.Sprintf("Install %s %s to:\n%s\n\nExisting pairing and settings are kept.", appName, version, directory)), mbIconInfo) {
		return nil
	}
	if !waitUntilClosed(directory) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(directory), 0o755); err != nil {
		return err
	}
	staging, err := os.MkdirTemp(filepath.Dir(directory), filepath.Base(directory)+".new-*")
	if err != nil {
		return err
	}
	previous := staging + ".previous"
	window := showProgress(text("正在安装 Grok Bot Local…", "Installing Grok Bot Local…"))
	defer window.close()
	size, err := extract(data, staging, func(done, total int) {
		if done%8 == 0 || done == total {
			window.set(text(fmt.Sprintf("正在安装 Grok Bot Local… %d%%", done*100/total), fmt.Sprintf("Installing Grok Bot Local… %d%%", done*100/total)))
		}
	})
	if err != nil {
		os.RemoveAll(staging)
		return err
	}
	head := make([]byte, data.offset)
	if _, err := data.file.ReadAt(head, 0); err != nil {
		os.RemoveAll(staging)
		return err
	}
	if err := os.WriteFile(filepath.Join(staging, uninstaller), head, 0o755); err != nil {
		os.RemoveAll(staging)
		return err
	}
	_, statErr := os.Stat(directory)
	existed := statErr == nil
	if existed {
		if err := checkDirectory(directory, true); err != nil {
			os.RemoveAll(staging)
			return err
		}
		if err := os.Rename(directory, previous); err != nil {
			os.RemoveAll(staging)
			return fmt.Errorf("%s: %w", text("无法替换已安装的版本", "Could not replace the installed version"), err)
		}
	}
	if err := os.Rename(staging, directory); err != nil {
		if existed {
			os.Rename(previous, directory)
		}
		os.RemoveAll(staging)
		return err
	}
	if existed {
		os.RemoveAll(previous)
	}
	window.set(text("正在创建快捷方式…", "Creating shortcuts…"))
	if err := registry(directory, version, size); err != nil {
		return err
	}
	if err := shortcuts(directory, !existed); err != nil {
		return err
	}
	window.close()
	if !silent && ask(text("安装完成。现在打开 Grok Bot Local？", "Installation complete. Open Grok Bot Local now?"), mbIconInfo) {
		command := exec.Command(filepath.Join(directory, exeName))
		command.Dir = directory
		command.Start()
	}
	return nil
}

// registryString reads a REG_SZ value below HKCU as UTF-16; reg.exe output uses the
// console code page and cannot carry every path.
func registryString(subkey, value string) string {
	const currentUser, stringType = 0x80000001, 0x2
	key, _ := syscall.UTF16PtrFromString(subkey)
	name, _ := syscall.UTF16PtrFromString(value)
	var size uint32
	if result, _, _ := regGetValue.Call(currentUser, uintptr(unsafe.Pointer(key)), uintptr(unsafe.Pointer(name)), stringType,
		0, 0, uintptr(unsafe.Pointer(&size))); result != 0 || size == 0 {
		return ""
	}
	buffer := make([]uint16, size/2+1)
	if result, _, _ := regGetValue.Call(currentUser, uintptr(unsafe.Pointer(key)), uintptr(unsafe.Pointer(name)), stringType,
		0, uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(&size))); result != 0 {
		return ""
	}
	return syscall.UTF16ToString(buffer)
}

// installedDirectory prefers the uninstaller's own folder, then the recorded location.
func installedDirectory(self string) string {
	if strings.EqualFold(filepath.Base(self), uninstaller) {
		return filepath.Dir(self)
	}
	if location := registryString(strings.TrimPrefix(registryKey, `HKCU\`), "InstallLocation"); location != "" {
		return location
	}
	return defaultDirectory()
}

func uninstall(self string, directory string) error {
	if err := checkDirectory(directory, false); err != nil {
		return err
	}
	// The uninstaller lives inside the directory it removes; continue from a temporary copy.
	if strings.EqualFold(filepath.Dir(self), filepath.Clean(directory)) {
		copyPath := filepath.Join(os.TempDir(), fmt.Sprintf("grokbot-uninstall-%d.exe", os.Getpid()))
		data, err := os.ReadFile(self)
		if err != nil {
			return err
		}
		if err := os.WriteFile(copyPath, data, 0o755); err != nil {
			return err
		}
		args := []string{"--uninstall-from", directory}
		if silent {
			args = append(args, "/S")
		}
		return exec.Command(copyPath, args...).Start()
	}
	if !ask(text("卸载 Grok Bot Local？", "Uninstall Grok Bot Local?"), mbIconWarning|mbDefButton2) && !silent {
		return nil
	}
	if !waitUntilClosed(directory) {
		return nil
	}
	// Never remove a folder that is not this application's installation.
	if err := checkDirectory(directory, false); err != nil {
		return err
	}
	if err := os.RemoveAll(directory); err != nil {
		return err
	}
	if err := removeIntegration(directory); err != nil {
		return err
	}
	if strings.EqualFold(filepath.Clean(registryString(strings.TrimPrefix(registryKey, `HKCU\`), "InstallLocation")), directory) {
		if err := run("reg.exe", "delete", registryKey, "/f"); err != nil {
			return err
		}
	}
	if !silent && ask(text("同时删除本机的配对凭据、设置和缓存吗？\n选择“否”可在重新安装后继续使用。",
		"Also remove this computer's pairing credentials, settings and caches?\nChoose No to keep them for a later installation."), mbIconWarning|mbDefButton2) {
		os.RemoveAll(filepath.Join(os.Getenv("APPDATA"), appName))
	}
	tell(text("Grok Bot Local 已卸载。", "Grok Bot Local has been uninstalled."), mbOK|mbIconInfo)
	// Remove the temporary uninstaller copy once this process has exited.
	if !strings.HasPrefix(filepath.Base(self), "grokbot-uninstall-") {
		return nil
	}
	cleanup := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
		`Wait-Process -Id $env:GB_PARENT -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $env:GB_TEMP_UNINSTALLER -Force`)
	cleanup.Env = append(os.Environ(), "GB_TEMP_UNINSTALLER="+self, fmt.Sprintf("GB_PARENT=%d", os.Getpid()))
	cleanup.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	cleanup.Start()
	return nil
}

func main() {
	language, _, _ := uiLanguage.Call()
	chinese = language&0x3ff == 0x04
	self, err := os.Executable()
	if err != nil {
		tell(err.Error(), mbIconError)
		os.Exit(1)
	}
	directory, mode, version := defaultDirectory(), "install", "0.71.2"
	for index := 1; index < len(os.Args); index++ {
		argument := os.Args[index]
		switch {
		case strings.EqualFold(argument, "/S"):
			silent = true
		case strings.HasPrefix(strings.ToUpper(argument), "/D="):
			// As with NSIS, /D= comes last and may contain unquoted spaces.
			directory = strings.Join(append([]string{argument[3:]}, os.Args[index+1:]...), " ")
			index = len(os.Args)
		case argument == "--uninstall":
			mode, directory = "uninstall", installedDirectory(self)
		case argument == "--uninstall-from" && index+1 < len(os.Args):
			mode, directory = "uninstall", os.Args[index+1]
			index++
		case strings.HasPrefix(argument, "--version="):
			version = strings.TrimPrefix(argument, "--version=")
		}
	}
	if mode == "install" {
		if data, err := readPayload(self); err == nil {
			if embedded, ok := embeddedVersion(data); ok {
				version = embedded
			}
			data.file.Close()
		}
		err = install(self, filepath.Clean(directory), version)
	} else {
		err = uninstall(self, filepath.Clean(directory))
	}
	if err != nil {
		tell(text("操作未完成：", "The operation did not finish: ")+err.Error(), mbIconError)
		os.Exit(1)
	}
}

// The patcher records the client version as the zip comment.
func embeddedVersion(data *payload) (string, bool) {
	reader, err := zip.NewReader(io.NewSectionReader(data.file, data.offset, data.size), data.size)
	if err != nil || reader.Comment == "" {
		return "", false
	}
	return reader.Comment, true
}
