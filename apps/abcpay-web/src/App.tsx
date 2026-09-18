import { Routes, Route } from 'react-router-dom';
import { TabBar } from './components/ui';
import { HomePage } from './pages/HomePage';
import { WalletsPage } from './pages/WalletsPage';
import { ScanPage } from './pages/ScanPage';
import { CreateWalletPage } from './pages/CreateWalletPage';
import { JoinWalletPage } from './pages/JoinWalletPage';
import { WalletDetailPage } from './pages/WalletDetailPage';
import { SendPage } from './pages/SendPage';
import { TokenSendPage } from './pages/TokenSendPage';
import { ReceivePage } from './pages/ReceivePage';
import { SettingsPage } from './pages/SettingsPage';
import { HistoryPage } from './pages/HistoryPage';
import { RestorePage } from './pages/RestorePage';

export function App() {
  return (
    <div className="min-h-screen pb-20">
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/wallets" element={<WalletsPage />} />
        <Route path="/scan" element={<ScanPage />} />
        <Route path="/create-wallet" element={<CreateWalletPage />} />
        <Route path="/join-wallet" element={<JoinWalletPage />} />
        <Route path="/wallet/:id" element={<WalletDetailPage />} />
        <Route path="/wallet/:id/send" element={<SendPage />} />
        <Route path="/wallet/:id/send-token/:tokenId" element={<TokenSendPage />} />
        <Route path="/wallet/:id/receive" element={<ReceivePage />} />
        <Route path="/wallet/:id/history" element={<HistoryPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/restore" element={<RestorePage />} />
      </Routes>
      <TabBar />
    </div>
  );
}
