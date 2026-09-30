/**
 * Tests for the stock ledger helpers.
 *
 *   node --test --import tsx lib/admin/stock-ledger.test.ts
 *
 * The properties that matter:
 *   • A hand-off line ("Name — Pack of 5") resolves to its product AND its
 *     pack size — taking 1 vial for a 5-pack is the bug this guards against.
 *   • An unknown line resolves to no product rather than a wrong one.
 *   • Manual vs automatic is decided by the source, so an admin-triggered
 *     "invoice paid" still reads as automatic (it links to the invoice).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  guessLineProduct,
  isMissingFunctionError,
  parseLineDescription,
  stockEntryKind,
} from './stock-ledger';

const PRODUCTS = [
  { id: 'p-bpc', name: 'BPC-157 10mg', puramass_sku: 'vyta-bpc-case', puramass_sku_vial: 'vyta-bpc-vial' },
  { id: 'p-tb', name: 'TB-500 5mg', puramass_sku: 'vyta-tb-case', puramass_sku_vial: 'vyta-tb-vial' },
];

test('parses hand-off pack and single-vial descriptions', () => {
  assert.deepEqual(parseLineDescription('BPC-157 10mg — Pack of 5'), { name: 'BPC-157 10mg', vialsPerUnit: 5 });
  assert.deepEqual(parseLineDescription('TB-500 5mg — Single vial'), { name: 'TB-500 5mg', vialsPerUnit: 1 });
  assert.deepEqual(parseLineDescription('TB-500 5mg (Single Vial)'), { name: 'TB-500 5mg', vialsPerUnit: 1 });
  assert.deepEqual(parseLineDescription('Something else'), { name: 'Something else', vialsPerUnit: null });
});

test('guesses the product and pack size by name', () => {
  assert.deepEqual(guessLineProduct('bpc-157 10MG — Pack of 10', PRODUCTS), { productId: 'p-bpc', vialsPerUnit: 10 });
  assert.deepEqual(guessLineProduct('TB-500 5mg — Single vial', PRODUCTS), { productId: 'p-tb', vialsPerUnit: 1 });
});

test('falls back to partner SKUs for legacy lines', () => {
  assert.deepEqual(guessLineProduct('vyta-tb-vial', PRODUCTS), { productId: 'p-tb', vialsPerUnit: 1 });
  // A case SKU never says how many vials — left for the admin to fill in.
  assert.deepEqual(guessLineProduct('vyta-bpc-case', PRODUCTS), { productId: 'p-bpc', vialsPerUnit: null });
});

test('an unknown line resolves to no product', () => {
  assert.deepEqual(guessLineProduct('Mystery peptide — Pack of 3', PRODUCTS), { productId: null, vialsPerUnit: 3 });
  assert.deepEqual(guessLineProduct('', PRODUCTS), { productId: null, vialsPerUnit: null });
});

test('classifies sources as manual, automatic or untracked', () => {
  assert.equal(stockEntryKind('admin_edit'), 'manual');
  assert.equal(stockEntryKind('csv_import'), 'manual');
  assert.equal(stockEntryKind('invoice_paid'), 'automatic');
  assert.equal(stockEntryKind('po_receipt'), 'automatic');
  assert.equal(stockEntryKind('untracked'), 'untracked');
});

test('recognises a missing RPC', () => {
  assert.equal(isMissingFunctionError({ code: 'PGRST202', message: 'x' }), true);
  assert.equal(isMissingFunctionError({ code: '42883', message: 'x' }), true);
  assert.equal(isMissingFunctionError({ message: 'Could not find the function public.set_product_stock' }), true);
  assert.equal(isMissingFunctionError({ code: '23505', message: 'duplicate key' }), false);
  assert.equal(isMissingFunctionError(null), false);
});
