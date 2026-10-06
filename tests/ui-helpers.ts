import type { Page } from "@playwright/test";
export async function notesField(page: Page) {
  const field = page.getByRole("textbox", { name: "Notes", exact: true });
  if (!await field.isVisible()) await page.getByRole("button", { name: "Edit notes", exact: true }).click();
  return field;
}
export async function organizationField(page: Page, name: string) {
  const section = page.locator(name === "Manual state" || name === "Session" ? ".source-details" : ".organization");
  if (name === "Manual state" || name === "Session") {
    if (await section.getAttribute("open") === null) await section.locator("summary").first().click();
  }
  const label = name === "Project" && await section.getByRole("combobox", { name: "Additional project", exact: true }).count() ? "Additional project" : name;
  return section.getByRole(name === "Chat name" ? "textbox" : "combobox", { name: label, exact: true });
}
export async function organizationButton(page: Page, name: string) {
  const section = page.locator(".organization");
  return section.getByRole("button", { name, exact: true });
}
