package project

import (
	"encoding/json"
	"maps"
	"strings"

	"mach/observer/internal/metrics"
)

// Checkpoints share what did not change (D18 of the M6.2 acceptance). A projection of a long
// history is mostly cells, slices, executions and waves that no longer change; encoding the whole
// state at every checkpoint cost a full copy each time (64 checkpoints of a 20 MB state held 1.2 GB
// while a 230,000-event history was read). A checkpoint is now the state's top level (everything
// but those four maps) plus one encoded blob per entity; an entity's blob is re-encoded only when
// an event touched it (State.touch), and the same bytes are shared by every checkpoint in which
// it did not change. Decoding a checkpoint gives exactly the state json.Marshal would have.

// checkpoint is the projection at one position.
type checkpoint struct {
	pos  uint64
	top  []byte            // the State with Waves, Slices, Cells and Executions left out
	ents map[string][]byte // entity key (entCell + id, ...) -> its encoding; shared, never changed
}

// size is the checkpoint's own bytes (blobs it shares with others are counted by each).
func (c checkpoint) size() int {
	n := len(c.top)
	for _, b := range c.ents {
		n += len(b)
	}
	return n
}

// entMetric keys one metric's aggregate cells of one day (metrics.Table.Part): like an entity,
// re-encoded only when an event wrote to that metric on that day, so a checkpoint does not copy
// every metric's whole history.
const entMetric = "m\x00"

// encodeTop encodes the state without its entity maps and metric cells.
func encodeTop(s *State) ([]byte, error) {
	waves, slices, cells, execs := s.Waves, s.Slices, s.Cells, s.Executions
	s.Waves, s.Slices, s.Cells, s.Executions = nil, nil, nil, nil
	var mcells map[string]map[string]*metrics.Agg
	if s.Metrics != nil {
		mcells, s.Metrics.Cells = s.Metrics.Cells, nil
	}
	data, err := json.Marshal(s)
	s.Waves, s.Slices, s.Cells, s.Executions = waves, slices, cells, execs
	if s.Metrics != nil {
		s.Metrics.Cells = mcells
	}
	return data, err
}

// encodeEntity encodes one entity, or returns nil when it is no longer in the state.
func encodeEntity(s *State, key string) ([]byte, error) {
	prefix, id, _ := strings.Cut(key, "\x00")
	var v any
	switch prefix + "\x00" {
	case entCell:
		if c := s.Cells[id]; c != nil {
			v = c
		}
	case entSlice:
		if sl := s.Slices[id]; sl != nil {
			v = sl
		}
	case entExecution:
		if x := s.Executions[id]; x != nil {
			v = x
		}
	case entWave:
		if w := s.Waves[id]; w != nil {
			v = w
		}
	case entMetric:
		if m := s.Metrics.Part(id); m != nil {
			v = m
		}
	}
	if v == nil {
		return nil, nil
	}
	return json.Marshal(v)
}

// allEntityKeys lists every entity of the state.
func allEntityKeys(s *State) []string {
	keys := make([]string, 0, len(s.Cells)+len(s.Slices)+len(s.Executions)+len(s.Waves))
	for id := range s.Cells {
		keys = append(keys, entCell+id)
	}
	for id := range s.Slices {
		keys = append(keys, entSlice+id)
	}
	for id := range s.Executions {
		keys = append(keys, entExecution+id)
	}
	for id := range s.Waves {
		keys = append(keys, entWave+id)
	}
	for _, part := range s.Metrics.PartKeys() {
		keys = append(keys, entMetric+part)
	}
	return keys
}

// blobs keeps the latest encoding of every entity of the live projection.
type blobs struct {
	m     map[string][]byte
	valid bool // false: re-encode every entity at the next checkpoint (a new base state)
}

// refresh brings the encodings up to date with the state: every entity when the base changed,
// otherwise the ones touched since the last checkpoint.
func (b *blobs) refresh(s *State) error {
	keys := make([]string, 0, len(s.dirty))
	if !b.valid || b.m == nil {
		b.m = map[string][]byte{}
		keys = allEntityKeys(s)
		b.valid = true
		s.Metrics.TakeDirty()
	} else {
		for k := range s.dirty {
			keys = append(keys, k)
		}
		for _, id := range s.Metrics.TakeDirty() {
			keys = append(keys, entMetric+id)
		}
	}
	for _, k := range keys {
		data, err := encodeEntity(s, k)
		if err != nil {
			return err
		}
		if data == nil {
			delete(b.m, k)
		} else {
			b.m[k] = data
		}
	}
	s.dirty = nil
	return nil
}

// snapshot makes a checkpoint of the live state at its position.
func (b *blobs) snapshot(s *State) (checkpoint, error) {
	if err := b.refresh(s); err != nil {
		return checkpoint{}, err
	}
	top, err := encodeTop(s)
	if err != nil {
		return checkpoint{}, err
	}
	return checkpoint{pos: s.Pos, top: top, ents: maps.Clone(b.m)}, nil
}

// decodeCheckpoint rebuilds a private state from a checkpoint.
func decodeCheckpoint(c checkpoint) (*State, error) {
	var s State
	if err := json.Unmarshal(c.top, &s); err != nil {
		return nil, err
	}
	s.Waves, s.Slices, s.Cells, s.Executions = map[string]*Wave{}, map[string]*Slice{}, map[string]*Cell{}, map[string]*Execution{}
	if s.Metrics == nil {
		s.Metrics = metrics.NewTable()
	}
	s.Metrics.Cells = map[string]map[string]*metrics.Agg{}
	for k, data := range c.ents {
		prefix, id, _ := strings.Cut(k, "\x00")
		var err error
		switch prefix + "\x00" {
		case entCell:
			v := &Cell{}
			err = json.Unmarshal(data, v)
			s.Cells[id] = v
		case entSlice:
			v := &Slice{}
			err = json.Unmarshal(data, v)
			s.Slices[id] = v
		case entExecution:
			v := &Execution{}
			err = json.Unmarshal(data, v)
			s.Executions[id] = v
		case entWave:
			v := &Wave{}
			err = json.Unmarshal(data, v)
			s.Waves[id] = v
		case entMetric:
			v := map[string]*metrics.Agg{}
			err = json.Unmarshal(data, &v)
			s.Metrics.SetPart(id, v)
		}
		if err != nil {
			return nil, err
		}
	}
	s.fill()
	return &s, nil
}
