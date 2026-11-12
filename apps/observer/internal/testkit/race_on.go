//go:build race

package testkit

// Race is true when the tests run under the race detector (-race), which slows them by a large
// factor; time limits in tests are scaled by Slow.
const Race = true
