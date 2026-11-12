package main

import (
	"bufio"
	"io"
	"net/http"
	"net/http/cookiejar"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"mach/observer/internal/testkit"
)

// A second browser reads the next one-time link from the observer's private link file.
func TestLinkFileForASecondBrowser(t *testing.T) {
	root := fixture(t)
	r := launch(t, root) // the first browser used the printed link
	defer r.stop(t)
	path := filepath.Join(root, IndexDir, LinkName)
	var link string
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(path); err == nil && strings.HasPrefix(string(data), "http://127.0.0.1:") {
			link = strings.TrimSpace(string(data))
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if link == "" {
		t.Fatal("no next link was saved")
	}
	if info, _ := os.Lstat(path); info.Mode().Perm() != 0o600 {
		t.Fatalf("link file mode %v", info.Mode().Perm())
	}
	jar, _ := cookiejar.New(nil)
	second := &http.Client{Jar: jar, Timeout: 5 * time.Second}
	resp, err := second.Get(link)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	for _, c := range []*http.Client{r.client, second} {
		resp, err := c.Get(r.base + "/api/v1/health")
		if err != nil || resp.StatusCode != 200 {
			t.Fatalf("a browser lost its session: %v", err)
		}
		resp.Body.Close()
	}
	data, _ := os.ReadFile(path)
	if strings.TrimSpace(string(data)) == link {
		t.Fatal("the used link was not replaced")
	}
	resp, _ = (&http.Client{Timeout: 5 * time.Second}).Get(link)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("a used link worked again: %d", resp.StatusCode)
	}
	resp.Body.Close()
}

// The Factory does not depend on the observer: killed mid-read (kill -9, during artifact reads,
// a stream and ingest), it leaves MACH's files exactly as they were, holds no MACH lock, and
// while it runs it keeps no MACH file open between reads.
func TestKilledMidReadLeavesTheFactoryAlone(t *testing.T) {
	if testing.Short() {
		t.Skip("builds the binary")
	}
	bin := filepath.Join(t.TempDir(), "mach-observer")
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, out)
	}
	root := fixture(t)
	big := make([]byte, 2<<20)
	for i := range big {
		big[i] = 'a' + byte(i%26)
	}
	testkit.Append(t, filepath.Join(root, ".factory/worktrees/T-1/evidence/big.txt"), big)
	before := testkit.HashTree(t, root, IndexDir)

	cmd := exec.Command(bin, "--project", root)
	stdout, _ := cmd.StdoutPipe()
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	link := ""
	sc := bufio.NewScanner(stdout)
	for sc.Scan() {
		if after, ok := strings.CutPrefix(sc.Text(), "Open: "); ok {
			link = after
			break
		}
	}
	go io.Copy(io.Discard, stdout)
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, Timeout: 5 * time.Second}
	resp, err := client.Get(link)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	base := strings.SplitN(link, "/?", 2)[0]
	r := &running{base: base, client: client}
	waitEvents(t, r, 7)

	// Sample the open files a few times while it is idle: nothing under the project but its own
	// folder may stay open (each poll opens, reads and closes).
	if _, err := exec.LookPath("lsof"); err == nil {
		seen := map[string]int{}
		const samples = 5
		for i := 0; i < samples; i++ {
			out, _ := exec.Command("lsof", "-p", itoa(cmd.Process.Pid), "-Fn").Output()
			for _, line := range strings.Split(string(out), "\n") {
				name, ok := strings.CutPrefix(line, "n")
				if ok && strings.HasPrefix(name, root+"/") && !strings.HasPrefix(name, filepath.Join(root, IndexDir)) {
					seen[name]++
				}
			}
			time.Sleep(150 * time.Millisecond)
		}
		for name, n := range seen {
			if n == samples {
				t.Errorf("the observer keeps a MACH file open: %s", name)
			}
		}
	}

	// Load: artifact reads and a stream, then kill -9 in the middle of them.
	var wg sync.WaitGroup
	stop := make(chan struct{})
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				for _, p := range []string{"/api/v1/artifacts", "/api/v1/snapshot", "/api/v1/cells/T-1/evidence", "/api/v1/stream?after="} {
					if resp, err := client.Get(base + p); err == nil {
						io.CopyN(io.Discard, resp.Body, 4096)
						resp.Body.Close()
					}
				}
			}
		}()
	}
	time.Sleep(300 * time.Millisecond)
	cmd.Process.Signal(syscall.SIGKILL)
	cmd.Wait()
	close(stop)
	wg.Wait()

	if diffs := testkit.DiffTrees(before, testkit.HashTree(t, root, IndexDir)); len(diffs) > 0 {
		t.Fatalf("a killed observer changed MACH's files: %v", diffs)
	}
	// MACH's own lock is free at once: the observer never takes it.
	f, err := os.OpenFile(filepath.Join(root, ".factory/intake/lock"), os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatalf("MACH's lock is held after the observer died: %v", err)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
