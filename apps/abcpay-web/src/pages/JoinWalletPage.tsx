import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { supportedCoins } from '@bcpros/abcpay-models';
import { joinWalletWithBwc } from '../lib/bwc';
import { saveCredentials } from '../lib/credentials-store';
import { useWallets, walletFromBwc } from '../context/WalletContext';

const joinWalletSchema = z.object({
  secret: z.string().min(1, 'Invitation secret is required'),
  name: z.string().min(1, 'Your name is required'),
  coin: z.enum(supportedCoins)
});

type JoinWalletForm = z.infer<typeof joinWalletSchema>;

export function JoinWalletPage() {
  const navigate = useNavigate();
  const { addWallet } = useWallets();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const { control, handleSubmit } = useForm<JoinWalletForm>({
    resolver: zodResolver(joinWalletSchema),
    defaultValues: { secret: '', name: '', coin: 'xec' }
  });

  const onSubmit = async (data: JoinWalletForm) => {
    setLoading(true);
    setError('');

    try {
      const result = await joinWalletWithBwc({
        secret: data.secret.trim(),
        copayerName: data.name,
        coin: data.coin
      });

      saveCredentials(result.walletId, result.credentials);

      const localWallet = walletFromBwc(
        result.walletId,
        'Shared Wallet',
        data.coin,
        0,
        0,
        result.copayerId,
        data.name,
        'pending'
      );

      addWallet(localWallet);
      navigate(`/wallet/${result.walletId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-lg mx-auto">
      <header className="px-4 py-4 border-b border-white/10">
        <h1 className="text-lg font-medium text-center">Join Shared Wallet</h1>
      </header>

      <form onSubmit={handleSubmit(onSubmit)} className="px-4 py-6 space-y-5">
        <p className="text-sm text-[var(--abcpay-muted)]">
          Paste the invitation secret shared by the wallet creator.
        </p>

        <div>
          <label className="block text-sm text-[var(--abcpay-muted)] mb-2">Invitation Secret</label>
          <Controller
            name="secret"
            control={control}
            render={({ field, fieldState }) => (
              <>
                <textarea
                  {...field}
                  rows={3}
                  placeholder="Paste invitation secret"
                  className="w-full px-4 py-3 bg-[var(--abcpay-surface)] rounded-xl border border-white/10 focus:border-[var(--abcpay-accent)] outline-none font-mono text-sm"
                />
                {fieldState.error && (
                  <p className="text-red-400 text-sm mt-1">{fieldState.error.message}</p>
                )}
              </>
            )}
          />
        </div>

        <div>
          <label className="block text-sm text-[var(--abcpay-muted)] mb-2">Your Name</label>
          <Controller
            name="name"
            control={control}
            render={({ field, fieldState }) => (
              <>
                <input
                  {...field}
                  placeholder="Bob"
                  className="w-full px-4 py-3 bg-[var(--abcpay-surface)] rounded-xl border border-white/10 focus:border-[var(--abcpay-accent)] outline-none"
                />
                {fieldState.error && (
                  <p className="text-red-400 text-sm mt-1">{fieldState.error.message}</p>
                )}
              </>
            )}
          />
        </div>

        <div>
          <label className="block text-sm text-[var(--abcpay-muted)] mb-2">Currency</label>
          <Controller
            name="coin"
            control={control}
            render={({ field }) => (
              <select
                {...field}
                className="w-full px-4 py-3 bg-[var(--abcpay-surface)] rounded-xl border border-white/10 focus:border-[var(--abcpay-accent)] outline-none"
              >
                {supportedCoins.map(c => (
                  <option key={c} value={c}>
                    {c.toUpperCase()}
                  </option>
                ))}
              </select>
            )}
          />
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full py-4 bg-[var(--abcpay-accent)] rounded-xl font-medium hover:opacity-90 disabled:opacity-50"
        >
          {loading ? 'Joining...' : 'Join Wallet'}
        </button>
      </form>
    </div>
  );
}
