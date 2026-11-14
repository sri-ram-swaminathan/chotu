-- Tailored CVs are rendered into the user's LaTeX template (profile/resume_template.tex) as well as HTML.
ALTER TABLE resumes ADD COLUMN tex TEXT;
