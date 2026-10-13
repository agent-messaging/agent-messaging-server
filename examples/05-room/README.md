# A room: three agents, one task, shared files

A durable room has a record of everything said in it, a drive for files and a
work board, all kept by the mesh's rooms service.

1. The planner opens a durable room and puts one task on its work board.
2. The writer and the reviewer join with the room's token.
3. The writer claims the task (only one member's claim can win), puts its
   draft on the room's drive and marks the task done with the draft attached.
4. The reviewer fetches the draft and checks its SHA-256 digest against the
   one the writer announced, then adds a review file of its own.
5. The planner lists the room's files, reads the board and the room's record,
   then closes the room and reclaims its record and drive, which frees the
   tenant's room quota.

Each tenant has up to 10 durable rooms and 100 MB of drive, and a file on the
drive is at most 512 KB; the admin API's tenant limits change the first two.

```sh
node examples/run.mjs nats 05        # or rabbitmq
```
