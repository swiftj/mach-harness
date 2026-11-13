// Package store is the observer's index: every version 3 event ingest committed, in delivery
// order, each at a position (pos) that never changes within an epoch. It is a projection of
// MACH's files, never a replacement: deleting it loses nothing, because it is rebuilt from the
// sources (under a new epoch, so clients know their cursors no longer apply).
//
// # On disk (.factory/local/observer/index/)
//
//	meta.json           format, epoch ("generation"), and the redaction and event versions it was built under
//	segment-NNNNNN.log  one event per line, in pos order; a segment is closed past Options.SegmentBytes (64 MiB)
//	checkpoints.json    each source's position, written atomically after the events read up to it are synced
//
// Whole oldest segments are dropped while the total is above Options.RetainBytes (512 MiB); the
// floor is then the last position of the dropped segment. A change of format, redaction rules
// (redact.Version) or event version starts a new epoch. A torn last line (a crash during append)
// is cut at open; anything else unreadable starts a new epoch.
//
// # Read API for other packages
//
// Safe for concurrent use with the one writer (ingest). Positions are 1, 2, 3… within an epoch;
// 0 means "before everything". A cursor on the wire is "<epoch>.<pos>" (event.Cursor).
//
//	Epoch() / Generation() string          the index epoch (16 hex)
//	Bounds() (floor, head uint64)          floor: one before the oldest position still served; head: the newest
//	Head() uint64                          the newest position
//	After(pos, limit) ([]Entry, error)     events after pos, in pos order (memory window, else the segments);
//	                                       ErrExpired below the floor, ErrFuture above the head
//	Run(Query) (Page, error)               events after a cursor with filters: Ticket, Execution, Entity (a
//	                                       "kind:id" ref) and TypePrefix; Page.Next is the position to resume after
//	ByTicket(t, after, limit)              Run with a ticket filter
//	ByExecution(x, after, limit)           Run with an execution filter
//	ByEntity(ref, after, limit)            Run with an entity-reference filter
//	History(HistoryQuery) HistoryPage      events in history ORDER (the `order` key), for replay and the Timeline
//	                                       (/api/v1/history): the memory window merged with the segments for what left
//	                                       it (orderindex.go); filters; pages never split an order key; a page stops
//	                                       early (More) past HistoryScanCap lines read from disk; Complete=false when
//	                                       retention may have dropped events of the window
//	Series(SeriesQuery) SeriesResult       event counts per time bucket (series.go): kept per minute for the whole
//	                                       index, also per ticket and per execution; finer buckets from memory
//	Get(id) (Entry, bool)                  one event in the memory window by id
//	Changed() <-chan struct{}              closed at the next append; take it before reading
//	Wait(ctx, after) error                 returns when the head passes after (wait-for-new)
//	Watermark() int64                      the live edge (contract 6.6): order_ms up to which history is complete
//	MaxOrder() string                      the largest order key committed
//	Info() Info                            epoch, head, floor, memory, segments, duplicates, rebuild reason
//
// Entry.Raw is the event's exact JSON line (the version 3 envelope, allow-listed and redacted by
// ingest before it was stored); Entry.Event is the decoded event. Callers must not modify either.
//
// The writer side (Append, Checkpoints, Lookup, SetWatermark) is for ingest only.
package store
