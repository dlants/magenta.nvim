I want to create a new sub-task for this overall architecture project - let's pull out the file interactions from the tools into a new environment layer.

The get_file tool and edl tool should get a new FileIO interface. That interface should allow them to read and write files, and abstract away all file system interactions.

The _permissions_ checking should be moved into this layer, so the tools themselves should just reach out and try to read/write files, and the FileIO layer should handle either automatically granting permissions or prompting the user.

The interface should be something like:

readFile(path: AbsFilePath) => Promise<Result<string>>
