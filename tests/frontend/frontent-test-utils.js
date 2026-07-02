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
        // Multi-user setups serve a login screen at '/'; single-user or
        // localhost-autologin setups serve the app page (which always
        // contains the preloader element) directly. Race the two markers
        // instead of waiting a fixed timeout for a login screen that may
        // never exist — that timeout would be paid by every single test.
        const userSelect = page.locator('#userList .userSelect').last();
        const loginVisible = userSelect.waitFor({ state: 'visible', timeout: 30000 }).then(() => 'login');
        const appAttached = page.waitForSelector('#preloader', { state: 'attached', timeout: 30000 }).then(() => 'app');
        loginVisible.catch(() => { /* lost the race: suppress the rejection */ });
        appAttached.catch(() => { /* lost the race: suppress the rejection */ });
        const appeared = await Promise.race([loginVisible, appAttached]);
        if (appeared === 'login') {
            await userSelect.click();
            await page.waitForURL('**/', { timeout: 10000 });
        }
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
    },
};
