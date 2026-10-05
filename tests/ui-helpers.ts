import type { Page } from "@playwright/test";
export async function notesField(page: Page) {
  const field = page.getByRole("textbox", { name: "Notes", exact: true });
  if (!await field.isVisible()) await page.getByRole("button", { name: "Edit notes", exact: true }).click();
  return field;
}
export async function organizationField(page: Page, name: string) {
  const section = page.locator(".organization");
  if (await section.getAttribute("open") === null) await section.locator("summary").first().click();
  return section.getByRole(name === "Chat name" ? "textbox" : "combobox", { name, exact: true });
}
export async function organizationButton(page: Page, name: string) {
  const section = page.locator(".organization");
  if (await section.getAttribute("open") === null) await section.locator("summary").first().click();
  return section.getByRole("button", { name, exact: true });
}
