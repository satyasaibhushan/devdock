import { mount } from 'svelte'
import App from './App.svelte'
import '@xterm/xterm/css/xterm.css'
import './app.css'

const target = document.getElementById('app')
if (!target) throw new Error('#app not found')

export default mount(App, { target })
