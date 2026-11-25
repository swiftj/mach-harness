package engine

// StageImportForTest checks a project.import request as the engine does before keeping its file,
// and gives it a fixed path in place of the kept copy, so its vector can be compared.
func StageImportForTest(args *ProjectImportArgs, path string) error {
	if _, _, err := args.check(); err != nil {
		return err
	}
	args.path = path
	return nil
}
