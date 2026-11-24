//go:build !unix

package artifact

// aliveOnThisSystem cannot tell elsewhere: a join under way is then reported as "unknown".
func aliveOnThisSystem(pid int) (alive, known bool) {
	return false, false
}
