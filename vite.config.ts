import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-node';
import { defineConfig } from 'vite';
export default defineConfig({ plugins: [sveltekit({ adapter: adapter(), paths: { origin: process.env.ORIGIN || undefined }, csp: { mode: 'auto', directives: { 'default-src': ['self'], 'style-src': ['self', 'unsafe-inline'], 'img-src': ['self', 'data:'], 'media-src': ['self'], 'object-src': ['none'], 'base-uri': ['self'], 'frame-ancestors': ['none'] } } })] });
