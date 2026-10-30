/**
 * Lock asincrono per chiave: serializza le sezioni critiche che lavorano sullo
 * stesso soggetto (una regola su un dispositivo) lasciando procedere in
 * parallelo quelle su soggetti diversi.
 *
 * Nasce dal percorso caldo del motore di automazioni: un sensore di potenza o
 * un PIR pubblicano a 1–2 Hz e ogni messaggio avvia una valutazione
 * asincrona. Senza serializzazione due valutazioni leggono lo stesso stato,
 * superano entrambe il controllo delle condizioni (TOCTOU) e comandano due
 * volte lo stesso relè. Il lock chiude quella finestra: chi arriva secondo
 * aspetta il rilascio, poi rivaluta lo stato aggiornato.
 *
 * - **FIFO per chiave**: la coda è un array di risvegli, servito in ordine di
 *   arrivo; nessun starvation fra richieste concorrenti;
 * - **timeout di acquisizione**: chi aspetta oltre `timeoutMs` viene rimosso
 *   dalla coda e riceve un errore, così un'esecuzione bloccata non lascia
 *   appesi per sempre i messaggi successivi;
 * - **rilascio idempotente**: `release()` può essere chiamato più volte (è il
 *   caso di un `finally` dopo un `return` anticipato) senza liberare il lock
 *   di un altro detentore.
 *
 * Vive nel processo: non coordina istanze del server. La serializzazione fra
 * più processi la fanno il broker e l'idempotenza dei comandi, non questo
 * modulo.
 */

/** Attesa massima predefinita per l'acquisizione di un lock. */
export const DEFAULT_KEYED_LOCK_TIMEOUT_MS = 500;

export class KeyedAsyncLock {
  /** Risvegli in attesa, per chiave, in ordine di arrivo. */
  private queues = new Map<string, Array<() => void>>();
  /** Chiavi attualmente detenute da un chiamante. */
  private activeLocks = new Set<string>();

  /**
   * Acquisisce il lock della chiave e restituisce la funzione di rilascio.
   *
   * Se la chiave è libera la promessa si risolve subito; altrimenti la
   * richiesta entra in coda e viene servita al rilascio del detentore. Con
   * `timeoutMs <= 0` l'attesa è illimitata (l'opzione esiste per i test):
   * il default di 500 ms è già oltre la latenza di un'esecuzione normale.
   */
  async acquire(key: string, timeoutMs: number = DEFAULT_KEYED_LOCK_TIMEOUT_MS): Promise<() => void> {
    if (!this.activeLocks.has(key)) {
      this.activeLocks.add(key);
      return this.createReleaser(key);
    }

    return new Promise<() => void>((resolve, reject) => {
      const queue = this.queues.get(key) ?? [];
      this.queues.set(key, queue);

      let timer: ReturnType<typeof setTimeout> | null = null;

      const run = () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        // Il lock passa di mano: `activeLocks` resta sulla chiave, è il nuovo
        // detentore a doverlo rilasciare.
        resolve(this.createReleaser(key));
      };

      const abandon = () => {
        timer = null;
        const pending = this.queues.get(key);
        const index = pending ? pending.indexOf(run) : -1;
        if (pending && index !== -1) pending.splice(index, 1);
        if (pending && pending.length === 0) this.queues.delete(key);
        reject(
          new Error(
            `Timeout [${timeoutMs}ms] durante l'acquisizione del lock per la chiave: ${key}`,
          ),
        );
      };

      // L'executor della Promise è sincrono: quando `acquire` ritorna la
      // richiesta è già in coda, quindi nessun rilascio può scavalcarla.
      queue.push(run);
      if (timeoutMs > 0) timer = setTimeout(abandon, timeoutMs);
    });
  }

  /** `true` se la chiave è detenuta (in esecuzione o in attesa di rilascio). */
  isLocked(key: string): boolean {
    return this.activeLocks.has(key);
  }

  /** Richieste in attesa sulla chiave, esclusa l'eventuale detentrice. */
  pending(key: string): number {
    return this.queues.get(key)?.length ?? 0;
  }

  /** Chiavi con almeno una richiesta in coda o un detentore (diagnostica). */
  keys(): string[] {
    return [...new Set([...this.activeLocks, ...this.queues.keys()])];
  }

  private createReleaser(key: string): () => void {
    let released = false;

    return () => {
      if (released) return;
      released = true;

      const queue = this.queues.get(key);
      const next = queue?.shift();
      if (queue && queue.length === 0) this.queues.delete(key);

      if (next) {
        // Passaggio di consegne diretto: la chiave non torna mai libera fra
        // due richieste in coda, quindi un terzo arrivato nel frattempo non
        // può inserirsi davanti a chi aspettava già.
        next();
        return;
      }

      this.activeLocks.delete(key);
    };
  }
}
