export const testSetup = {
    /**
     * Navigates to the home page without waiting for SillyTavern to load.
     * @param {Object} params
     * @param {import('@playwright/test').Page} params.page
     */
    goST: async ({ page }) => {
        await page.goto('/');
    },

    /**
     * Waits for SillyTavern to fully load by navigating to the home page and waiting for the preloader to disappear.
     * Handles both multi-user setups (clicks through the login screen) and
     * single-user / localhost-autologin setups (no login screen exists).
     * @param {Object} params
     * @param {import('@playwright/test').Page} params.page
     */
    awaitST: async ({ page }) => {
        await page.goto('/');
        try {
            await page.locator('#userList .userSelect').last().click({ timeout: 5000 });
            await page.waitForURL('**/', { timeout: 10000 });
        } catch {
            // No login screen: the app is loading directly.
        }
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
    },
};
