package security

import (
	"errors"
	"net"
	"net/netip"
	"strconv"
)

// ErrNotLoopback refuses any address but the loopback interface.
var ErrNotLoopback = errors.New("the observer listens on the loopback interface only (127.0.0.1)")

// Listen binds host:port, where host must be the literal loopback address 127.0.0.1. Names
// (even "localhost", which a hosts file can point anywhere), wildcards, other loopback
// addresses and every other interface are refused before anything is bound. Port 0 picks a
// free port. The command line offers no way to choose host; it is a parameter so tests can
// prove the refusal.
func Listen(host string, port int) (net.Listener, error) {
	if port < 0 || port > 65535 {
		return nil, errors.New("the port must be between 0 and 65535")
	}
	addr, err := netip.ParseAddr(host)
	if err != nil || addr != netip.MustParseAddr("127.0.0.1") {
		return nil, ErrNotLoopback
	}
	l, err := net.Listen("tcp4", net.JoinHostPort(addr.String(), strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	if tcp, ok := l.Addr().(*net.TCPAddr); !ok || !tcp.IP.IsLoopback() {
		l.Close()
		return nil, ErrNotLoopback
	}
	return l, nil
}
