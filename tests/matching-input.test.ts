import { test } from "node:test";
import assert from "node:assert/strict";
import { compactMatchingText } from "../src/shared/matching-input";

test("matching copies reduce Jira URLs to existing parser keys and preserve negation and labels",()=>{
  assert.equal(compactMatchingText("Don't work on https://team.atlassian.net/browse/pay-42?selectedIssue=PAY-42#comment. Work on [refund retries](https://jira.example/jira/browse/PAY-87)."),
    "Don't work on PAY-42. Work on refund retries (PAY-87).");
  assert.equal(compactMatchingText("See <https://jira.example/browse/APP-8> and [APP-8](https://jira.example/browse/APP-8)."),"See APP-8 and APP-8.");
  assert.equal(compactMatchingText("[PAY-42 login regression](https://jira.example/browse/PAY-42)"),"PAY-42 login regression");
});
test("Confluence cloud and self-hosted pretty URLs preserve decoded titles",()=>{
  assert.equal(compactMatchingText("Use https://team.atlassian.net/wiki/spaces/ENG/pages/123/Payment+Retry+Design?ref=nav#details"),"Use Payment Retry Design");
  assert.equal(compactMatchingText("Read https://docs.example/confluence/display/ENG/Token%20Authentication%20%E2%80%93%20Notes"),"Read Token Authentication – Notes");
  assert.equal(compactMatchingText("[Background](https://docs.example/spaces/ENG/pages/123/Retry+Design)"),"Background (Retry Design)");
});
test("Markdown labels and GitHub references keep topic evidence without the full URL",()=>{
  assert.equal(compactMatchingText("[Login regression](https://example.org/opaque/9f2?q=long \"Background\") and https://github.com/team/deck/pull/87?diff=split"),
    "Login regression and team/deck PR #87");
  assert.equal(compactMatchingText("[Billing](https://example.org/Function_(math))[Other](https://other.example/doc)."),"BillingOther.");
  assert.equal(compactMatchingText("https://github.com/team/deck/issues/12"),"team/deck issue #12");
});
test("opaque, malformed and credentialed URLs stay unchanged and no page title is invented",()=>{
  for(const url of ["https://team.atlassian.net/wiki/x/AbCd","https://docs.example/pages/viewpage.action?pageId=123", "https://docs.example/spaces/ENG/pages/123", "https://example.org/design?id=42#authentication", "https://user:secret@jira.example/browse/PAY-42", "https://docs.example/display/ENG/%FF"])
    assert.equal(compactMatchingText(url),url);
  assert.equal(compactMatchingText("[here](https://example.org/opaque)"),"[here](https://example.org/opaque)");
});
test("whitespace compaction preserves sentence order and meaningful words",()=>{
  assert.equal(compactMatchingText("  Not\t\tpayments. \n\n\n\n  Actually   authentication.  "),"Not payments.\n\nActually authentication.");
});
