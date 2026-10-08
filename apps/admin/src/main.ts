import { mount } from 'svelte';
import '@mpf/brand/theme.css';
import './panel.css';
import App from './App.svelte';

export default mount(App, { target: document.getElementById('app')! });
