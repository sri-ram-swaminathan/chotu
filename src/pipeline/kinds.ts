// Opportunity-kind detection from titles. Dependency-free so tests can import it directly.

/** "Intern", "Internship", "Stagiair", "Afstudeerstage", "Werkstudent", "Working student", "Thesis" — not "International". */
export const INTERNSHIP_TITLE = /\b(?:interns?|internships?|stagiair[es]*|afstudeer\w*|afstudeerstage|meewerkstage|werkstudent\w*|working student|thesis|praktikum|praktikant\w*)\b/i;
