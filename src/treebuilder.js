class ComponentTree {
    constructor(interpreter, callback, options = {}) {
        // Storing off args
        this.interpreter = interpreter;
        this.callback = callback;
        this.options = options;

        // identifier!
        this._id = interpreter.id;

        // path -> meta lookup
        this._paths = new Map();

        // State tracking
        this._req = 0;

        // Get goin
        this._prep();
        this._watch();
    }

    teardown() {
        this._paths.clear();

        this._unsubscribe();
    }

    // Walk the machine and build up maps of paths to meta info as
    // well as prepping any load functions for usage later
    _prep() {
        const { _paths } = this;
        const { idMap : ids } = this.interpreter.machine;

        // xstate maps ids to state nodes, but the value object only
        // has paths, so need to create our own path-only map here
        for(const id in ids) {
            const { path, meta = false } = ids[id];

            const key = path.join(".");

            if(!meta) {
                continue;
            }

            _paths.set(key, {
                component : meta.component,

                loader : meta.load ?
                    async (item, ...args) => {
                        item.component = await meta.load(...args);
                    } :
                    false,
            });
        }
    }

    // Watch the machine for changes
    _watch() {
        const { interpreter } = this;
    
        const { unsubscribe } = interpreter.subscribe(this._state.bind(this));

        this._unsubscribe = unsubscribe;

        // In case the machine is already started, run a first pass on it
        if(interpreter.initialized) {
            this._state(interpreter.state);
        }
    }

    // Walk a machine via BFS, collecting meta information to build a tree
    // eslint-disable-next-line max-statements
    async _walk({ value, context, event }) {
        const { _paths } = this;
        
        const loads = [];
        const tree = {
            __proto__ : null,
            children  : [],
            id        : this._id,
        };

        // Set up queue for a breadth-first traversal of all active states
        let queue;

        if(typeof value === "string") {
            queue = [[ tree, value, false ]];
        } else {
            queue = Object.entries(value).map(([ child, grandchildren ]) =>
                [ tree, child, grandchildren ]
            );
        }

        while(queue.length) {
            const [ parent, path, values ] = queue.shift();

            // Since it can be assigned if we add a new child
            let pointer = parent;

            if(_paths.has(path)) {
                const { component, loader } = _paths.get(path);
                const item = {
                    __proto__ : null,
                    children  : [],
                    component : component || false,
                };

                // Run load function and assign the response to the component prop
                if(loader) {
                    loads.push(loader(item, context, event));
                }

                parent.children.push(item);

                pointer = item;
            }

            if(!values) {
                continue;
            }

            if(typeof values === "string") {
                queue.push([ pointer, `${path}.${values}`, false ]);

                continue;
            }

            queue.push(...Object.entries(values).map(([ child, grandchildren ]) =>
                [ pointer, `${path}.${child}`, grandchildren ]
            ));
        }

        // await all the load functions
        await Promise.all(loads);

        return tree;
    }
    
    // eslint-disable-next-line max-statements
    async _state(state) {
        const { changed, value, context, event } = state;

        // Need to specifically check for false because this value is undefined
        // when a machine first boots up
        if(changed === false) {
            return;
        }

        this._req += 1;
        const ver = this._req;

        const tree = await this._walk({ value, context, event });
        
        // statechart transitioned again before component tree was ready, so
        // throw away the old values
        if(ver !== this._req) {
            return;
        }
        
        this.callback(tree);
    }
}

const treeBuilder = (interpreter, fn) => {
    const machines = new Map();
    const trees = new Map();

    const root = interpreter.id;

    const respond = () => {
        fn([ ...trees.values() ]);
    };

    machines.set(root, new ComponentTree(interpreter, (tree) => {
        trees.set(root, tree);

        respond();
    }));

    interpreter.subscribe(({ changed, children }) => {
        if(changed === false) {
            return;
        }

        // BFS Walk child statecharts, attach subscribers for each of them
        const queue = Object.entries(children);
        
        // Track active ids
        const active = new Set();

        while(queue.length) {
            const [ id, machine ] = queue.shift();

            active.add(id);

            machines.set(id, new ComponentTree(machine, (tree) => {
                trees.set(id, tree);

                respond();
            }));

            if(machine.initialized && machine.state) {
                queue.push(...Object.entries(machine.state.children));
            }
        }

        // Remove any no-longer active invoked statecharts from being tracked
        machines.forEach((cancel, id) => {
            if(active.has(id) || id === root) {
                return;
            }

            machines.get(id).teardown();
            machines.delete(id);
            trees.delete(id);

            respond();
        });
    });
};

export {
    treeBuilder,
    ComponentTree,
};
