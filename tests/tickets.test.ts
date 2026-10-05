import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTicket, resolveTicketUrl } from "../src/shared/tickets";
import { jiraBaseUrl } from "../src/shared/validation";

test("ticket numbers resolve using Jira settings; explicit URLs override the base", () => {
  const key = parseTicket(" deck-42 ");
  assert.deepEqual(key, { jiraKey: "DECK-42", jiraUrl: "" });
  assert.equal(resolveTicketUrl(key, { jiraBaseUrl: jiraBaseUrl.parse("https://company.example/jira///") }), "https://company.example/jira/browse/DECK-42");
  const link = parseTicket("https://other.example/jira/browse/deck-42?view=detail#comment");
  assert.equal(link.jiraKey, "DECK-42");
  assert.equal(resolveTicketUrl(link, { jiraBaseUrl: "https://new.example" }), link.jiraUrl);
  assert.deepEqual(parseTicket("https://other.example/ticket?id=42"), { jiraKey: "", jiraUrl: "https://other.example/ticket?id=42" });
  assert.deepEqual(parseTicket(""), { jiraKey: "", jiraUrl: "" });
  assert.throws(() => resolveTicketUrl(key, { jiraBaseUrl: "" }), /Settings/);
});
test("ticket inputs and settings reject executable URLs, credentials and malformed bases", () => {
  for (const value of ["javascript:alert(1)", "file:///tmp/ticket", "https://user:secret@jira.example/browse/DECK-42", "DECK-", "42", "x".repeat(2001)]) assert.throws(() => parseTicket(value));
  for (const value of ["https://jira.example?account=1", "https://jira.example#fragment", "https://user:secret@jira.example", "file:///tmp"]) assert.equal(jiraBaseUrl.safeParse(value).success, false);
  assert.equal(jiraBaseUrl.parse(""), "");
});
