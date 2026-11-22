import { mount } from 'svelte';
import './app.css';
import './register-sw.js';
import App from './shell/App.svelte';

mount(App, { target: document.getElementById('app')! });
