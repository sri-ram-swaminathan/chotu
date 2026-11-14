// Job boards, ATS detection, /like parsing, internship detection, calendar feed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHnComment, parseStartupJobsRss } from "../src/sources/boards.ts";
import { detectAts } from "../src/sources/ats.ts";
import { INTERNSHIP_TITLE } from "../src/pipeline/kinds.ts";
import { companyFromTarget, parseLike } from "../src/orchestrator/likeParse.ts";
import { toIcs } from "../src/api/ics.ts";

test("HN comment → company, role, location", () => {
  const j = parseHnComment({ id: 1, created_at: "2026-11-02T16:01:43.000Z",
    text: "Sereact | Robot Learning Engineer | Stuttgart, Germany | ONSITE | Full-time<p>We build foundation models for robots." });
  assert.equal(j?.company, "Sereact");
  assert.equal(j?.title, "Robot Learning Engineer");
  assert.match(j!.location!, /Stuttgart/);
  assert.equal(j?.url, "https://news.ycombinator.com/item?id=1");
  assert.equal(parseHnComment({ id: 2, text: "Just a reply without pipes" }), null);
});

test("startup.jobs RSS item", () => {
  const xml = `<item><title>ML Engineer at Acme Robotics</title><link>https://startup.jobs/ml-engineer-acme-1?utm_source=rss</link>
    <guid isPermaLink="true">https://startup.jobs/ml-engineer-acme-1</guid><pubDate>Thu, 12 Nov 2026 16:08:40 +0000</pubDate>
    <description>Train perception models.

Amsterdam, Netherlands · €60.000 per year</description></item>`;
  const [j] = parseStartupJobsRss(xml);
  assert.equal(j?.company, "Acme Robotics");
  assert.equal(j?.title, "ML Engineer");
  assert.equal(j?.location, "Amsterdam, Netherlands");
  assert.equal(j?.url, "https://startup.jobs/ml-engineer-acme-1");
});

test("ATS URLs are recognised", () => {
  assert.deepEqual(detectAts("https://jobs.ashbyhq.com/sereact"), { ats: "ashby", slug: "sereact" });
  assert.deepEqual(detectAts("https://job-boards.greenhouse.io/anthropic/jobs/123"), { ats: "greenhouse", slug: "anthropic" });
  assert.deepEqual(detectAts("https://jobs.eu.lever.co/tomtom"), { ats: "lever-eu", slug: "tomtom" });
  assert.deepEqual(detectAts("https://philips.wd3.myworkdayjobs.com/en-US/jobs-and-careers"), { ats: "workday", slug: "philips.wd3/jobs-and-careers" });
  assert.equal(detectAts("https://sereact.ai/careers"), null);
});

test("/like parsing", () => {
  assert.deepEqual(parseLike("/like Sereact — robot learning, small team"), { target: "Sereact", reason: "robot learning, small team" });
  assert.deepEqual(parseLike("/like Black Forest Labs - open image models"), { target: "Black Forest Labs", reason: "open image models" });
  assert.deepEqual(parseLike("/like https://jobs.ashbyhq.com/sereact because robots"), { target: "https://jobs.ashbyhq.com/sereact", reason: "because robots" });
  assert.deepEqual(parseLike("/like Wayve: world models for driving"), { target: "Wayve", reason: "world models for driving" });
  assert.deepEqual(parseLike("/like Wayve"), { target: "Wayve", reason: "" });
  assert.equal(parseLike("/like"), null);
  assert.equal(companyFromTarget("https://jobs.ashbyhq.com/black-forest-labs").name, "Black Forest Labs");
  assert.deepEqual(companyFromTarget("https://www.sereact.ai/careers"), { name: "Sereact", domain: "sereact.ai", url: "https://www.sereact.ai/careers" });
});

test("internship titles", () => {
  for (const t of ["ML Intern", "Internship Computer Vision", "Stagiair AI", "Afstudeerstage Robotics", "Werkstudent KI", "Master Thesis: LLM agents", "Praktikum Robotik"])
    assert.ok(INTERNSHIP_TITLE.test(t), t);
  for (const t of ["International Sales", "Internal Tools Engineer", "ML Engineer", "Robotics Engineer, Interaction"])
    assert.ok(!INTERNSHIP_TITLE.test(t), t);
});

test("ICS feed: all-day events, escaping, folding", () => {
  const ics = toIcs([
    { id: "d1", org: "Y Combinator", title: "Spring 2027 batch, apply", kind: "accelerator", date: "2027-02-10", status: "open",
      confidence: "verified", evidence: "Applications close Feb 10; late apps ok", source_url: "https://ycombinator.com/apply", job_url: null },
    { id: "d2", org: "X", title: "rolling", kind: "phd", date: null, status: "rolling", confidence: "verified", evidence: null, source_url: null, job_url: null },
  ], new Date("2026-11-13T10:00:00Z"));
  assert.match(ics, /BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART;VALUE=DATE:20270210\r\n/);
  assert.match(ics, /DTEND;VALUE=DATE:20270211\r\n/);
  assert.match(ics, /SUMMARY:Y Combinator — Spring 2027 batch\\, apply/);
  assert.ok(!ics.includes("UID:d2@chotu"), "undated items are not calendar events");
  assert.ok(ics.split("\r\n").every((l) => l.length <= 75), "lines folded");
});
