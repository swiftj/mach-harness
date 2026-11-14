//go:build !unix

package store

// oNoFollow is not available here; the folder check in OpenWith still refuses a linked folder.
const oNoFollow = 0
