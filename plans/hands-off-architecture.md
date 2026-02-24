# root

- capacity providers
  - dev containers (hands off)
  - worktree (hands on)
  - local (hands on)
- project manager agent
  - can observe worker agent state
  - given info about available worker slots
  - has access to project management db

# task

user or agent provides description
planning agent, generates a plan
implementation agent, takes a plan and creates an implementation
cicd runs

- If cicd fails,

QA agent - takes the implementation + plan, verifies test coverage, etc...

- QA agent can pass this on for human review, or create a new task and bounce it back to implementation agent
  -> human approval / PR

when human accepts changes, we merge it (possibly there's conflicts in which case we can crete a new task
task result reported to project manager agent

# project management db:

each project is a local md file
yaml frontmatter

- project priority
- blockers
- list of things that need to be done

to start with, let's just load it all into memory, create a grpah. Eventually we can put it into sqlite or something.

# questions

where do branches live? Who can create branches and merge branches? Is there a branch per task?
what happens if a task is too large for one implementation agent? How do we detect this and break it down into smaller pieces?
should we split things off into individual tasks, and create a branch per task? Or work with larger planning units - projects, etc... Does this live in a single md file or something more structured? Maybe a folder per project, with a md file per task?
is project/task split necessary? Technically we could just use deps to construct a sequence in a task tree?
when orchestrating against a dev container, what happens when I try to look at a file, change or what the agent did?
