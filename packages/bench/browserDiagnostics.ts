import type { Page } from 'playwright'

/** Collect asynchronous failures instead of silently including failed runs in the samples. */
export function captureBrowserErrors(page: Page, errors: string[] = []) {
	page.on('pageerror', (error) => errors.push(error.message))
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text())
	})
	return errors
}
