'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import type { Customer } from '@/lib/supabase';
import { apiFetch } from '@/lib/api-fetch';
import { identifyVisitor } from '@/lib/customer/activity';
import { takePostAuthRedirect } from '@/lib/customer/post-auth-redirect';

interface CustomerContextType {
  customer: Customer | null;
  isLoading: boolean;
  refreshCustomer: () => Promise<void>;
  logout: () => Promise<void>;
}

const CustomerContext = createContext<CustomerContextType | undefined>(undefined);

const withTimeout = <T,>(promise: Promise<T>, ms = 10000): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), ms)
    ),
  ]);

export function CustomerProvider({ children }: { children: React.ReactNode }) {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadCustomer = async () => {
    console.log('[Auth] loadCustomer: start');
    try {
      const { data: { session } } = await withTimeout(supabase.auth.getSession(), 8000);
      console.log('[Auth] loadCustomer: session fetched', session ? 'exists' : 'null');

      if (!session?.user) {
        setCustomer(null);
        return;
      }

      console.log('[Auth] loadCustomer: querying customer by ID');
      let { data } = await withTimeout(
        supabase.from('customers').select('*').eq('id', session.user.id).single(),
        8000
      );
      console.log('[Auth] loadCustomer: DB query done', data ? 'found' : 'not found');

      if (!data && session.access_token) {
        console.log('[Auth] loadCustomer: trying fallback API');
        try {
          const result = await apiFetch<{ customer: Customer }>('/api/auth/customer', {
            method: 'POST',
            body: JSON.stringify({ accessToken: session.access_token }),
            timeoutMs: 8000,
          });
          data = result.customer;
          console.log('[Auth] loadCustomer: fallback API result', data ? 'found' : 'not found');
        } catch (e) {
          console.error('[Auth] loadCustomer: fallback API failed', e);
        }
      }

      setCustomer(data ?? null);
      console.log('[Auth] loadCustomer: customer set', data ? data.id : 'null');
    } catch (error) {
      console.error('[Auth] loadCustomer: error', error);
      setCustomer(null);
    } finally {
      setIsLoading(false);
      console.log('[Auth] loadCustomer: done');
    }
  };

  useEffect(() => {
    loadCustomer();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      console.log('[Auth] onAuthStateChange:', event, 'session:', session ? 'exists' : 'null');

      // A recovery session that arrived anywhere but /reset-password (e.g. the
      // Site URL fallback) must still end on the new-password form, not leave
      // the visitor quietly signed in on whatever page they landed.
      if (event === 'PASSWORD_RECOVERY' && window.location.pathname !== '/reset-password') {
        window.location.assign('/reset-password');
        return;
      }

      if (event === 'SIGNED_IN') {
        setTimeout(() => {
          loadCustomer();
        }, 0);
        // Hand this browser's anonymous browsing history to the account, and
        // freeze the channel that brought them in onto the customer row. Fire
        // and forget — it never blocks the sign-in, and it is idempotent, so
        // a token refresh that re-fires SIGNED_IN costs one no-op request.
        void identifyVisitor();

        // Signed in from an email-confirmation link after signing up to view
        // an order: carry on to that order. The login/signup forms redirect
        // on their own (and clear this), so leave those pages alone.
        const path = window.location.pathname;
        if (path !== '/login' && path !== '/signup' && path !== '/reset-password') {
          const pending = takePostAuthRedirect();
          if (pending && pending !== `${path}${window.location.search}`) {
            window.location.assign(pending);
          }
        }
      }

      if (event === 'SIGNED_OUT') {
        setCustomer(null);
        setIsLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const refreshCustomer = async () => {
    await loadCustomer();
  };

  const logout = async () => {
    console.log('[Auth] logout: signing out');
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    // 403 means the session was already expired server-side — local state still needs clearing
    if (error && error.status !== 403) {
      console.error('[Auth] logout: signOut error', error);
    }
    console.log('[Auth] logout: clearing customer state');
    setCustomer(null);
    setIsLoading(false);
  };

  return (
    <CustomerContext.Provider value={{ customer, isLoading, refreshCustomer, logout }}>
      {children}
    </CustomerContext.Provider>
  );
}

export function useCustomer() {
  const context = useContext(CustomerContext);
  if (context === undefined) {
    throw new Error('useCustomer must be used within a CustomerProvider');
  }
  return context;
}
