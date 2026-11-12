//go:build !unix

package normalize

import "os"

// openNoFollow opens a file read-only. The caller has already refused links with Lstat.
func openNoFollow(path string) (*os.File, error) { return os.Open(path) }
