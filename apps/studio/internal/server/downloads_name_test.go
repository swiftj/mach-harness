package server

import "testing"

// The export's own names (project_export._reserve): -2, -3 ... after the time when two land in one second.
func TestTheProjectFileNames(t *testing.T) {
	for _, name := range []string{"mach-project-lending-20261124T100000Z.zip", "mach-project-lending-20261124T100000Z-2.zip", "mach-project-a1-20261124T100000Z-999.zip"} {
		if !projectFileName.MatchString(name) {
			t.Errorf("%s is the export's own name", name)
		}
	}
	for _, name := range []string{"mach-project-lending-20261124T100000Z-0.zip", "mach-project-lending-20261124T100000Z-1000.zip", "mach-project-lending-20261124T100000Z-2.zip.zip",
		"mach-project-Lending-20261124T100000Z.zip", "../mach-project-lending-20261124T100000Z.zip", "mach-jira.csv"} {
		if projectFileName.MatchString(name) {
			t.Errorf("%s is not the export's name", name)
		}
	}
}
