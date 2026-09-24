import { emitKeypressEvents } from 'node:readline'
import { hashPassword } from '../server/hosted/password.ts'

async function hiddenPrompt(prompt: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Run this command in an interactive terminal.')
  }
  process.stdout.write(prompt)
  emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  let value = ''
  try {
    return await new Promise<string>((resolve, reject) => {
      const onKeypress = (text: string, key: { name?: string; ctrl?: boolean }) => {
        if (key.ctrl && key.name === 'c') {
          process.stdin.off('keypress', onKeypress)
          reject(new Error('Password input cancelled.'))
        } else if (key.name === 'return' || key.name === 'enter') {
          process.stdin.off('keypress', onKeypress)
          process.stdout.write('\n')
          resolve(value)
        } else if (key.name === 'backspace') {
          value = value.slice(0, -1)
        } else if (text && !key.ctrl) {
          value += text
        }
      }
      process.stdin.on('keypress', onKeypress)
    })
  } finally {
    process.stdin.setRawMode(false)
    process.stdin.pause()
  }
}

const first = await hiddenPrompt('Admin password: ')
const second = await hiddenPrompt('Repeat password: ')
if (first !== second) throw new Error('The passwords do not match.')
console.log(await hashPassword(first))
