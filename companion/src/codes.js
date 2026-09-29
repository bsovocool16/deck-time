// Standard UTBMS (ABA Uniform Task-Based Management System) code sets.
// Exported to Intapp as u5 (task) and u6 (activity). Firms and clients add
// their own variants; override or extend these in config.codes.

export const ACTIVITY_CODES = {
  A101: 'Plan and prepare for',
  A102: 'Research',
  A103: 'Draft/revise',
  A104: 'Review/analyze',
  A105: 'Communicate (in firm)',
  A106: 'Communicate (with client)',
  A107: 'Communicate (other outside counsel)',
  A108: 'Communicate (other external)',
  A109: 'Appear for/attend',
  A110: 'Manage data/files',
  A111: 'Other',
};

export const TASK_SETS = {
  counseling: {
    label: 'Counseling (C)',
    codes: {
      C100: 'Fact gathering',
      C200: 'Researching law',
      C300: 'Analysis and advice',
      C400: 'Third party communication',
    },
  },
  litigation: {
    label: 'Litigation (L)',
    codes: {
      L110: 'Fact investigation/development',
      L120: 'Analysis/strategy',
      L130: 'Experts/consultants',
      L140: 'Document/file management',
      L150: 'Budgeting',
      L160: 'Settlement/non-binding ADR',
      L190: 'Other case assessment, development and administration',
      L210: 'Pleadings',
      L220: 'Preliminary injunctions/provisional remedies',
      L230: 'Court mandated conferences',
      L240: 'Dispositive motions',
      L250: 'Other written motions and submissions',
      L260: 'Class action certification and notice',
      L310: 'Written discovery',
      L320: 'Document production',
      L330: 'Depositions',
      L340: 'Expert discovery',
      L350: 'Discovery motions',
      L390: 'Other discovery',
      L410: 'Fact witnesses',
      L420: 'Expert witnesses',
      L430: 'Written motions and submissions',
      L440: 'Other trial preparation and support',
      L450: 'Trial and hearing attendance',
      L460: 'Post-trial motions and submissions',
      L470: 'Enforcement',
      L510: 'Appellate motions and submissions',
      L520: 'Appellate briefs',
      L530: 'Oral argument',
    },
  },
};

/** Allowed codes for a matter, or null if it doesn't use codes. */
export function codesFor(matter, config) {
  if (!matter?.code_set) return null;
  const set = config.codes.taskSets[matter.code_set];
  if (!set) return null;
  return { tasks: set.codes, activities: config.codes.activities };
}
