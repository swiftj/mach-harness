package hostdir

import (
	"bufio"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func tempRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root
}

// A project with no tool folder keeps nothing: no folder is made.
func TestNoToolFolderKeepsNothing(t *testing.T) {
	root := tempRoot(t)
	d, err := Prepare(root)
	if err != nil || d != nil {
		t.Fatalf("want nothing, got %v %v", d, err)
	}
	if _, err := os.Lstat(filepath.Join(root, ".factory")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a tool folder was made where there was none")
	}
	if _, err := Prepare("relative"); err == nil {
		t.Fatal("a relative root was accepted")
	}
}

// The folder is private, ignored by git, and the link file is private and replaced atomically.
func TestFolderAndLinkArePrivate(t *testing.T) {
	root := tempRoot(t)
	os.Mkdir(filepath.Join(root, ".factory"), 0o755)
	d, err := Prepare(root)
	if err != nil || d == nil {
		t.Fatalf("prepare: %v", err)
	}
	if d.Path != filepath.Join(root, filepath.FromSlash(Rel)) {
		t.Fatalf("folder %s", d.Path)
	}
	info, _ := os.Stat(d.Path)
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("folder mode %v", info.Mode().Perm())
	}
	ignore, _ := os.ReadFile(filepath.Join(d.Path, ".gitignore"))
	if !strings.Contains(string(ignore), "\n*\n") {
		t.Fatalf(".gitignore %q", ignore)
	}
	for _, link := range []string{"http://127.0.0.1:1/?t=a", "http://127.0.0.1:1/?t=b"} {
		if err := d.WriteLink(link); err != nil {
			t.Fatal(err)
		}
		data, _ := os.ReadFile(d.LinkPath())
		if string(data) != link+"\n" {
			t.Fatalf("link file %q", data)
		}
		info, _ := os.Lstat(d.LinkPath())
		if info.Mode().Perm() != 0o600 || !info.Mode().IsRegular() {
			t.Fatalf("link file mode %v", info.Mode())
		}
	}
	entries, _ := os.ReadDir(d.Path)
	for _, e := range entries {
		if e.Name() != ".gitignore" && e.Name() != LinkName {
			t.Fatalf("a temporary file was left: %s", e.Name())
		}
	}
	d.RemoveLink()
	if _, err := os.Lstat(d.LinkPath()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the link file was not removed")
	}
	// Prepared again (a later start): still fine, and a loosened folder is made private again.
	os.Chmod(d.Path, 0o755)
	if d2, err := Prepare(root); err != nil || d2 == nil {
		t.Fatalf("prepare again: %v", err)
	}
	if info, _ := os.Stat(d.Path); info.Mode().Perm() != 0o700 {
		t.Fatalf("folder mode after a second start %v", info.Mode().Perm())
	}
}

// A symbolic link in place of either folder is refused, and nothing is written through it.
func TestLinkedFoldersAreRefused(t *testing.T) {
	for _, which := range []string{"machine-local", "host"} {
		t.Run(which, func(t *testing.T) {
			root := tempRoot(t)
			outside := tempRoot(t)
			host := filepath.Join(root, filepath.FromSlash(Rel))
			os.MkdirAll(filepath.Dir(host), 0o700)
			place := host
			if which != "host" {
				place = filepath.Dir(host)
				os.Remove(place)
			}
			if err := os.Symlink(outside, place); err != nil {
				t.Fatal(err)
			}
			if d, err := Prepare(root); err == nil || d != nil {
				t.Fatalf("a linked %s folder was accepted", which)
			}
			if entries, _ := os.ReadDir(outside); len(entries) != 0 {
				t.Fatalf("something was written through the link: %v", entries)
			}
		})
	}
}

// A link planted where the link file goes is replaced, never followed.
func TestPlantedLinkFileIsReplacedNotFollowed(t *testing.T) {
	root := tempRoot(t)
	os.Mkdir(filepath.Join(root, ".factory"), 0o755)
	d, _ := Prepare(root)
	target := filepath.Join(tempRoot(t), "target")
	os.WriteFile(target, []byte("keep"), 0o644)
	os.Symlink(target, d.LinkPath())
	if err := d.WriteLink("http://127.0.0.1:1/?t=x"); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(target); string(data) != "keep" {
		t.Fatalf("written through the link: %q", data)
	}
	if info, _ := os.Lstat(d.LinkPath()); !info.Mode().IsRegular() {
		t.Fatal("the planted link is still there")
	}
}

// One host per project: a second lock is refused while the first is held, and works after it.
func TestOneHostPerProject(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("locks are not used on Windows")
	}
	root := tempRoot(t)
	os.Mkdir(filepath.Join(root, ".factory"), 0o755)
	d, _ := Prepare(root)
	first, err := d.Acquire()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Acquire(); !errors.Is(err, ErrHeld) {
		t.Fatalf("a second host was allowed: %v", err)
	}
	if ErrHeld.Error() != "another Product Studio is already running for this project" {
		t.Fatalf("message %q", ErrHeld)
	}
	first.Release()
	again, err := d.Acquire()
	if err != nil {
		t.Fatalf("not free after release: %v", err)
	}
	again.Release()
}

// A host that is killed leaves no lock behind: the next start takes it.
func TestKilledHostLeavesNoLock(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("locks are not used on Windows")
	}
	if dir := os.Getenv("HOSTDIR_TEST_HOLD"); dir != "" {
		if _, err := (&Dir{Path: dir}).Acquire(); err != nil {
			os.Exit(3)
		}
		os.Stdout.WriteString("held\n")
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	root := tempRoot(t)
	os.Mkdir(filepath.Join(root, ".factory"), 0o755)
	d, _ := Prepare(root)
	cmd := exec.Command(os.Args[0], "-test.run=^TestKilledHostLeavesNoLock$")
	cmd.Env = append(os.Environ(), "HOSTDIR_TEST_HOLD="+d.Path)
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	line, _ := bufio.NewReader(out).ReadString('\n')
	if line != "held\n" {
		cmd.Process.Kill()
		cmd.Wait()
		t.Fatalf("the child did not take the lock: %q", line)
	}
	if _, err := d.Acquire(); !errors.Is(err, ErrHeld) {
		cmd.Process.Kill()
		cmd.Wait()
		t.Fatalf("the child's lock was not seen: %v", err)
	}
	cmd.Process.Kill() // no clean-up runs: as after a crash
	cmd.Wait()
	l, err := d.Acquire()
	if err != nil {
		t.Fatalf("the lock outlived the killed host: %v", err)
	}
	l.Release()
}
