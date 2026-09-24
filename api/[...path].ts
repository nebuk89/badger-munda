import type { Request, Response } from 'express'
import { createHostedApp } from '../server/hosted/app.ts'

const app = createHostedApp()

export default async function handler(req: Request, res: Response) {
  return (await app)(req, res)
}
