// Broadening Circles - card data (from Spring 2026 rules PDF)

var CHALLENGES = [
  "Data Loss","Tokenism","Attrition","Breach of Trust","Bias Against the Project",
  "Supply Line Problems","Tech Failure","Natural Disaster","Loss of Funding",
  "Loss of Space","Scandal","Mis-/Disinformation","Coding Errors","War / Terrorism",
  "Coordinated Attacks / Campaigns","Community Backlash","Lack / Loss of Community Interest"
];

var VALUES = [
  "Honesty","Power Sharing","Diversity & Inclusion","Family-Focused","Anti-Racist",
  "Supportive Leadership","Generosity","Flexibility","Respect","Compassion","Cooperation"
];

// Balanced team resources
var RESOURCES_BALANCED = [
  "Interdisciplinary statistician",
  "Experienced senior faculty member",
  "Media & Communications Expert",
  "Healthcare providers",
  "Doctoral student in dissertation planning phase",
  "Institutional-level ethics staff member assigned to the project",
  "Institutionally-assigned librarian for project",
  "Regular reporting to collaborating facilities/groups",
  "Create newsletter with contributions from a range of stakeholders",
  "Develop logo, brand identity and other media",
  "Plan bonding incentives for participants",
  "Participate in friend-making events with community and collaboration institutions",
  "Coordinate with local news sources for project updates",
  "Equipment gift from colleague's lab",
  "Supply inheritance from research group that left organization",
  "Furniture donation from sponsor facility renovation"
];

// Research-centered resources
var RESOURCES_RESEARCH = [
  "Principal Investigator (PI)",
  "Compliance Officer",
  "Trainees with professional experience",
  "Faculty collaborator dedicated to the project",
  "Collaborator with big research lab",
  "Institutional-level expert coordinator",
  "New faculty hire with corresponding interest and skill",
  "Shared decision-making among team members",
  "Give credit for contributions",
  "Offer range of roles to stakeholders",
  "Organize informal social activities",
  "Consult with the expert patient advisory group",
  "Ensure regular bi-directional communication",
  "Plan a range of opportunities for impact",
  "Team experience with managing scope and complex tasks",
  "Access to patients",
  "Access to community space",
  "Space",
  "Time",
  "Funding for equipment",
  "Supplemental intramural grant"
];

// Patient-centered resources
var RESOURCES_PATIENT = [
  "Principal Investigator (PI)",
  "Research sponsor who values participatory research",
  "Staff with a track record of engaging patients",
  "Study coordinator with first-hand experience with studied variables",
  "Diversity, Equity & Inclusion Expert",
  "Patient / family group liaison",
  "Community group liaison",
  "Celebrity patient advisory member",
  "Develop educational materials using co-design methods",
  "Get help from opinion leaders",
  "Pursue evidence beyond scientific publications",
  "Develop agenda collaboratively",
  "Spend time explaining the problem to the community",
  "Participant compensation",
  "Host listening circles",
  "Conduct focus groups with stakeholders with a feedback loop",
  "Validate personal experiences",
  "Create a shared vocabulary glossary",
  "Relationships with patient organizations",
  "Relationship with influential community member",
  "Social / Community Networks",
  "Team experience with managing scope and complex tasks",
  "Access to patients"
];

// Patient-centered outcomes
var OUTCOMES_PATIENT = [
  "Research priority setting is transformed",
  "Quality of care improves",
  "The burden of the health problem improves",
  "Patient education quality improves",
  "Trust is sustained among stakeholders",
  "Stakeholders gain confidence and life skills",
  "Stakeholders collaborate with researchers",
  "Stakeholders empowered to develop their own voice",
  "Affiliation with large charity group",
  "Stakeholders supplement funding",
  "Family engagement for patient support broadens",
  "Family members reach a higher level of engagement with the project",
  "Affiliation with new clinical groups serving patients"
];

// Research-centered outcomes
var OUTCOMES_RESEARCH = [
  "Improved enrollment and decreased attrition",
  "Data collection tool improvements",
  "Improved findings dissemination",
  "Improved understanding of problems",
  "Building of community rapport",
  "Improved appraisal of research engagement",
  "Alignment of research with priorities",
  "Improved study finding mobilization",
  "New sponsor offers funding to extend the project",
  "New colleagues request to join the team",
  "Team member asked to give a national keynote about the project",
  "Researcher(s) offered promotions or bonus",
  "Prestigious journal offers theme-based issue"
];

// Team metadata. 'outcomeColor' drives which color piece a team places.
// Per rules: outcome-card color decides the piece color. Balanced team has both types of outcomes.
var TEAMS = {
  research: { display: "Research-Centered", short: "Research", color: "#e85c4a", resources: RESOURCES_RESEARCH, outcomes: OUTCOMES_RESEARCH, outcomeColor: "research" },
  patient:  { display: "Patient-Centered",  short: "Patient",  color: "#2f5aa8", resources: RESOURCES_PATIENT,  outcomes: OUTCOMES_PATIENT,  outcomeColor: "patient" },
  balanced: { display: "Balanced",          short: "Balanced", color: "#9b9b9b", resources: RESOURCES_BALANCED, outcomes: [], outcomeColor: "mixed" }
};
var TEAM_IDS = ["research","patient","balanced"];

// Piece color palette (matches outcome card type)
var PIECE_COLORS = {
  research: "#e85c4a",
  patient:  "#2f5aa8"
};

// Sector difficulty lengths, from PDF pages 30-32
var SECTOR_LENGTHS = { easy: 9, medium: 13, hard: 20 };
var SECTOR_IDS = ["easy","medium","hard"];
var SECTOR_LABELS = { easy: "Easy", medium: "Medium", hard: "Hard" };

function shuffle(arr) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function pick(arr, n) { return shuffle(arr).slice(0, n); }

// 3-sided die: values 1,2,3
function roll3() { return 1 + Math.floor(Math.random() * 3); }

// Build a standard environment deck: 1 Value first, then 6 random mix of Challenge+Value
function buildEnvDeck(total) {
  total = total || 8;
  var first = { type: "value", text: VALUES[Math.floor(Math.random()*VALUES.length)] };
  var pool = [];
  CHALLENGES.forEach(function(t){ pool.push({ type:"challenge", text:t }); });
  VALUES.forEach(function(t){ pool.push({ type:"value", text:t }); });
  var rest = shuffle(pool).slice(0, total - 1);
  return [first].concat(rest);
}
