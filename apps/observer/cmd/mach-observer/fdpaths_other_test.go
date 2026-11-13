//go:build !darwin && !linux

package main

func openPaths() []string { return nil }

const canListOpenPaths = false
