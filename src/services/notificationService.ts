import { io } from "../index";

export const notifyNewItem = (item: any) => {
    if (io) {
        io.emit("queue-new-item", item);
    }
};
