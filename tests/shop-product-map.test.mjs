// Run locally with: node --test tests/shop-product-map.test.mjs
// No Netlify deploy, credentials, network or production writes required.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {catalog} from '../netlify/functions/nebu-catalog.mjs';

const mapping=JSON.parse(readFileSync(new URL('../push-test/shop-product-map.json',import.meta.url),'utf8'));
const customerHtml=readFileSync(new URL('../push-test/customer.html',import.meta.url),'utf8');
const match=customerHtml.match(/const menu=(\[.*?\]);const root=document.getElementById\('menuPreview'\)/s);
const customerItems=match?JSON.parse(match[1]).flatMap(group=>group.items.map(item=>({...item,category:group.category}))):[];

test('76 unique, reversible product IDs and shop keys',()=>{
 assert.equal(mapping.products.length,76);
 assert.equal(new Set(mapping.products.map(p=>p.testId)).size,76);
 assert.equal(new Set(mapping.products.map(p=>p.shopKey)).size,76);
 for(const p of mapping.products)assert.equal(p.shopKey,p.category+'||'+p.name);
});

test('mapping matches server catalog (IDs, names, categories)',()=>{
 assert.equal(catalog.length,mapping.products.length);
 const byId=new Map(catalog.map(p=>[p.id,p]));
 for(const p of mapping.products){
  const item=byId.get(p.testId);
  assert.ok(item,'Unknown catalog ID '+p.testId);
  assert.equal(p.name,item.name);
  assert.equal(p.category,item.category);
 }
});

test('mapping matches customer test menu',()=>{
 assert.equal(customerItems.length,76,'Customer menu could not be read or has changed');
 const byId=new Map(customerItems.map(p=>[p.id,p]));
 for(const p of mapping.products){
  const item=byId.get(p.testId);
  assert.ok(item,'Unknown customer ID '+p.testId);
  assert.equal(p.name,item.name);
  assert.equal(p.category,item.category);
 }
});

test('sold-out mapping does not match unknown products',()=>{
 const byShopKey=new Map(mapping.products.map(p=>[p.shopKey,p.testId]));
 assert.equal(byShopKey.get('Vorspeisen||Miso Shiru (vegan)'),'p001');
 assert.equal(byShopKey.get('Unbekannt||Nicht vorhanden'),undefined);
});
