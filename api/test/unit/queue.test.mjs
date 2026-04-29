import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Queue from '../../helpers/queue.js';

describe('Queue', () => {
    it('add() assigns a uuid id and returns it', () => {
        const q = new Queue();
        const item = {};
        const id = q.add(item);
        assert.equal(typeof id, 'string');
        assert.ok(id.length > 0);
        assert.equal(item.id, id);
    });

    it('add() preserves a provided id', () => {
        const q = new Queue();
        const item = { id: 'custom-id' };
        const id = q.add(item);
        assert.equal(id, 'custom-id');
        assert.equal(item.id, 'custom-id');
    });

    it('getSize() increments on add', () => {
        const q = new Queue();
        assert.equal(q.getSize(), 0);
        q.add({});
        assert.equal(q.getSize(), 1);
        q.add({});
        assert.equal(q.getSize(), 2);
    });

    it('getSize() decrements on shift', () => {
        const q = new Queue();
        q.add({});
        q.add({});
        q.shift();
        assert.equal(q.getSize(), 1);
    });

    it('getSize() decrements on remove', () => {
        const q = new Queue();
        const item = {};
        q.add(item);
        q.add({});
        q.remove(item.id);
        assert.equal(q.getSize(), 1);
    });

    it('shift() returns null on empty queue', () => {
        const q = new Queue();
        assert.equal(q.shift(), null);
    });

    it('shift() returns items in FIFO order', () => {
        const q = new Queue();
        const a = { id: 'a' };
        const b = { id: 'b' };
        q.add(a);
        q.add(b);
        assert.equal(q.shift(), a);
        assert.equal(q.shift(), b);
        assert.equal(q.shift(), null);
    });

    it('remove() removes by id and returns the item', () => {
        const q = new Queue();
        const item = { id: 'x', data: 42 };
        q.add(item);
        const removed = q.remove('x');
        assert.equal(removed, item);
        assert.equal(q.getSize(), 0);
    });

    it('remove() returns null for missing id', () => {
        const q = new Queue();
        q.add({ id: 'a' });
        assert.equal(q.remove('nonexistent'), null);
        assert.equal(q.getSize(), 1);
    });

    it('requeue() puts item at front so next shift returns it', () => {
        const q = new Queue();
        const a = { id: 'a' };
        const b = { id: 'b' };
        q.add(a);
        const item = { id: 'front' };
        q.add(b);
        q.requeue(item);
        assert.equal(q.shift(), item);
        assert.equal(q.shift(), a);
    });

    it('getPosition() returns 1-based position for an item in queue', () => {
        const q = new Queue();
        const a = { id: 'a' };
        const b = { id: 'b' };
        q.add(a);
        q.add(b);
        assert.equal(q.getPosition('a'), 1);
        assert.equal(q.getPosition('b'), 2);
    });

    it('getPosition() returns null for missing id', () => {
        const q = new Queue();
        q.add({ id: 'a' });
        assert.equal(q.getPosition('nope'), null);
    });
});
