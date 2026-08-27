export const metadata = {
  title: 'Payment Reconciliation Engine',
  description: 'Razorpay AI Buildathon Track 4 — reconciliation engine and the Analyst',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
