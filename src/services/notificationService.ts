import { io } from '../index';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const notifyQueueUpdate = (item: any) => {
  if (io) {
    io.emit('queue-updated', item);
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const notifyNewItem = (item: any) => {
  if (io) {
    io.emit('queue-new-item', item);
  }
};
