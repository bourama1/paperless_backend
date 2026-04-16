import { io } from '../index';

export const notifyQueueUpdate = (item: any) => {
  if (io) {
    io.emit('queue-updated', item);
  }
};

export const notifyNewItem = (item: any) => {
  if (io) {
    io.emit('queue-new-item', item);
  }
};
