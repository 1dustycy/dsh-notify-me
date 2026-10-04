# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Type labels

The five roles above answer *who acts next*. A type answers *what kind of thing this is*. The two axes are independent and combine freely — a `bug` that is fully specified and ready to hand off carries both `bug` and `ready-for-agent`.

| Label | Meaning                                       |
| ----- | --------------------------------------------- |
| `bug` | Existing behaviour is wrong, or breaks a rule |

Add a row when a second type genuinely earns its keep, not one per issue. An issue with a type and no role has not been triaged yet.
