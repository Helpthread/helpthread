import { redirect } from 'next/navigation'

/** The inbox IS the app — land in the open folder. */
export default function Home() {
  redirect('/inbox/open')
}
